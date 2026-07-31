import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import process from "node:process";
import { installTerminalSafetyNet } from "../src/terminalSafetyNet";

describe("installTerminalSafetyNet", () => {
	let stdoutSpy: ReturnType<typeof spyOn>;
	let stderrSpy: ReturnType<typeof spyOn>;
	let written: string[];
	let stderrWritten: string[];
	let exitSpy: ReturnType<typeof spyOn>;
	let originalExit: typeof process.exit;
	let uninstall: (() => void) | null = null;
	let releaseOrder: string[];
	let releases: (() => void)[];

	beforeEach(() => {
		written = [];
		stderrWritten = [];
		releaseOrder = [];
		releases = [() => releaseOrder.push("mouse"), () => releaseOrder.push("altScreen")];
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation(((
			chunk: string | Uint8Array,
			..._args: unknown[]
		) => {
			written.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		}) as never);
		stderrSpy = spyOn(process.stderr, "write").mockImplementation(((
			chunk: string | Uint8Array,
			..._args: unknown[]
		) => {
			stderrWritten.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		}) as never);
		// Replace process.exit with a no-op so we can observe calls without
		// actually terminating the test runner.
		originalExit = process.exit;
		exitSpy = spyOn(process, "exit").mockImplementation(((_code?: number) => undefined) as never);
	});

	afterEach(() => {
		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
		exitSpy.mockRestore();
		process.exit = originalExit;
		if (uninstall) {
			uninstall();
			uninstall = null;
		}
	});

	/**
	 * Bun's test runner calls process.exit as part of its own teardown
	 * after each test. To verify whether *our* handler called exit, we
	 * snapshot the call count right before the event and compare right after
	 * — any delta is attributable to our code, not Bun's plumbing.
	 */
	function expectDelta(callCountBefore: number, expected: number) {
		expect(exitSpy.mock.calls.length - callCountBefore).toBe(expected);
	}

	it("releases in array order and exits 130 on SIGINT", () => {
		uninstall = installTerminalSafetyNet(releases);
		const callsBefore = exitSpy.mock.calls.length;

		process.emit("SIGINT");

		// Order matters: the inner mode (mouse) has to be released before the
		// alternate screen it was nested inside.
		expect(releaseOrder).toEqual(["mouse", "altScreen"]);
		expect(written).toEqual(["\n"]);
		expectDelta(callsBefore, 1);
		expect(exitSpy.mock.calls[callsBefore]?.[0]).toBe(130);
	});

	it("releases and exits 143 on SIGTERM", () => {
		uninstall = installTerminalSafetyNet(releases);
		const callsBefore = exitSpy.mock.calls.length;

		process.emit("SIGTERM");

		expect(releaseOrder).toEqual(["mouse", "altScreen"]);
		expectDelta(callsBefore, 1);
		expect(exitSpy.mock.calls[callsBefore]?.[0]).toBe(143);
	});

	it("releases on uncaughtException and exits 1", () => {
		uninstall = installTerminalSafetyNet(releases);
		const callsBefore = exitSpy.mock.calls.length;

		process.emit("uncaughtException", new Error("boom"));

		expect(stderrWritten.some((line) => line.includes("[cli] uncaught:"))).toBe(true);
		expect(releaseOrder).toEqual(["mouse", "altScreen"]);
		expectDelta(callsBefore, 1);
		expect(exitSpy.mock.calls[callsBefore]?.[0]).toBe(1);
	});

	it("releases on unhandledRejection and exits 1", () => {
		uninstall = installTerminalSafetyNet(releases);
		const callsBefore = exitSpy.mock.calls.length;

		process.emit("unhandledRejection", "rejected-value");

		expect(stderrWritten.some((line) => line.includes("[cli] unhandled rejection"))).toBe(true);
		expect(releaseOrder).toEqual(["mouse", "altScreen"]);
		expectDelta(callsBefore, 1);
		expect(exitSpy.mock.calls[callsBefore]?.[0]).toBe(1);
	});

	it("releases on beforeExit without calling process.exit", () => {
		uninstall = installTerminalSafetyNet(releases);
		const callsBefore = exitSpy.mock.calls.length;

		process.emit("beforeExit", 0);

		expect(releaseOrder).toEqual(["mouse", "altScreen"]);
		// beforeExit must NOT itself call process.exit — Node emits it right
		// before the loop drains, so terminating here would skip subsequent
		// cleanup.
		expectDelta(callsBefore, 0);
	});

	it("uninstall removes every handler", () => {
		uninstall = installTerminalSafetyNet(releases);
		uninstall();
		uninstall = null;
		const callsBefore = exitSpy.mock.calls.length;

		process.emit("SIGINT");

		expect(releaseOrder).toEqual([]);
		expectDelta(callsBefore, 0);
	});
});

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import process from "node:process";
import {
	__resetAltScreenForTests,
	enterAltScreen,
	exitAltScreen,
	installAltScreenSafetyNet,
} from "../src/altScreen";

const ENTER_ALT = "\x1b[?1049h\x1b[H";
const EXIT_ALT = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

describe("altScreen", () => {
	let stdoutSpy: ReturnType<typeof spyOn>;
	let stderrSpy: ReturnType<typeof spyOn>;
	let written: string[];
	let stderrWritten: string[];
	let exitSpy: ReturnType<typeof spyOn>;
	let uninstall: (() => void) | null = null;
	let originalIsTTY: boolean | undefined;
	let originalExit: typeof process.exit;

	beforeEach(() => {
		__resetAltScreenForTests();
		written = [];
		stderrWritten = [];
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
		// actually terminating the test runner. Capture and stash the
		// original so afterEach can restore it.
		originalExit = process.exit;
		exitSpy = spyOn(process, "exit").mockImplementation(((_code?: number) => undefined) as never);
		originalIsTTY = process.stdout.isTTY;
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
		__resetAltScreenForTests();
		Object.defineProperty(process.stdout, "isTTY", {
			value: originalIsTTY,
			configurable: true,
			writable: true,
		});
	});

	function setTTY(value: boolean | undefined) {
		Object.defineProperty(process.stdout, "isTTY", {
			value,
			configurable: true,
			writable: true,
		});
	}

	/**
	 * Bun's test runner calls process.exit as part of its own teardown
	 * after each test. To verify whether *our* handler called exit, we
	 * snapshot the call count right before the event and compare right after
	 * — any delta is attributable to our code, not Bun's plumbing.
	 */
	function expectDelta(callCountBefore: number, expected: number) {
		const after = exitSpy.mock.calls.length;
		expect(after - callCountBefore).toBe(expected);
	}

	describe("enterAltScreen", () => {
		it("writes the enter sequence + hides the cursor when stdout is a TTY", () => {
			setTTY(true);
			const result = enterAltScreen();
			expect(result).toBe(true);
			expect(written).toEqual([ENTER_ALT, HIDE_CURSOR]);
		});

		it("is a no-op when stdout is not a TTY", () => {
			setTTY(false);
			const result = enterAltScreen();
			expect(result).toBe(false);
			expect(written).toEqual([]);
		});

		it("is idempotent — a second call writes nothing", () => {
			setTTY(true);
			enterAltScreen();
			enterAltScreen();
			expect(written).toEqual([ENTER_ALT, HIDE_CURSOR]);
		});
	});

	describe("exitAltScreen", () => {
		it("is a no-op when we never entered", () => {
			setTTY(true);
			exitAltScreen();
			expect(written).toEqual([]);
		});

		it("writes show-cursor + exit sequence after entering", () => {
			setTTY(true);
			enterAltScreen();
			written.length = 0;
			exitAltScreen();
			expect(written).toEqual([SHOW_CURSOR, EXIT_ALT]);
		});

		it("is idempotent — a second exit writes nothing", () => {
			setTTY(true);
			enterAltScreen();
			exitAltScreen();
			exitAltScreen();
			expect(written).toEqual([ENTER_ALT, HIDE_CURSOR, SHOW_CURSOR, EXIT_ALT]);
		});

		it("allows re-entry after exit", () => {
			setTTY(true);
			enterAltScreen();
			exitAltScreen();
			written.length = 0;
			enterAltScreen();
			expect(written).toEqual([ENTER_ALT, HIDE_CURSOR]);
		});
	});

	describe("installAltScreenSafetyNet", () => {
		it("releases the alternate buffer and exits 130 on SIGINT", () => {
			setTTY(true);
			enterAltScreen();
			written.length = 0;
			uninstall = installAltScreenSafetyNet();
			const callsBefore = exitSpy.mock.calls.length;

			process.emit("SIGINT");

			expect(written).toEqual([SHOW_CURSOR, EXIT_ALT, "\n"]);
			expectDelta(callsBefore, 1);
			expect(exitSpy.mock.calls[callsBefore]?.[0]).toBe(130);
		});

		it("releases the alternate buffer and exits 143 on SIGTERM", () => {
			setTTY(true);
			enterAltScreen();
			written.length = 0;
			uninstall = installAltScreenSafetyNet();
			const callsBefore = exitSpy.mock.calls.length;

			process.emit("SIGTERM");

			expect(written).toEqual([SHOW_CURSOR, EXIT_ALT]);
			expectDelta(callsBefore, 1);
			expect(exitSpy.mock.calls[callsBefore]?.[0]).toBe(143);
		});

		it("releases the alternate buffer on uncaughtException and exits 1", () => {
			setTTY(true);
			enterAltScreen();
			written.length = 0;
			uninstall = installAltScreenSafetyNet();
			const callsBefore = exitSpy.mock.calls.length;

			process.emit("uncaughtException", new Error("boom"));

			expect(stderrWritten.some((s) => s.includes("[cli] uncaught:"))).toBe(true);
			expect(written).toContain(SHOW_CURSOR);
			expect(written).toContain(EXIT_ALT);
			expectDelta(callsBefore, 1);
			expect(exitSpy.mock.calls[callsBefore]?.[0]).toBe(1);
		});

		it("releases the alternate buffer on unhandledRejection and exits 1", () => {
			setTTY(true);
			enterAltScreen();
			written.length = 0;
			uninstall = installAltScreenSafetyNet();
			const callsBefore = exitSpy.mock.calls.length;

			process.emit("unhandledRejection", "rejected-value");

			expect(stderrWritten.some((s) => s.includes("[cli] unhandled rejection"))).toBe(true);
			expect(written).toContain(SHOW_CURSOR);
			expect(written).toContain(EXIT_ALT);
			expectDelta(callsBefore, 1);
			expect(exitSpy.mock.calls[callsBefore]?.[0]).toBe(1);
		});

		it("releases the alternate buffer on beforeExit without calling process.exit", () => {
			setTTY(true);
			enterAltScreen();
			written.length = 0;
			uninstall = installAltScreenSafetyNet();
			const callsBefore = exitSpy.mock.calls.length;

			process.emit("beforeExit", 0);

			expect(written).toEqual([SHOW_CURSOR, EXIT_ALT]);
			// beforeExit must NOT itself call process.exit — Node emits it
			// right before the loop drains, so terminating here would skip
			// subsequent cleanup.
			expectDelta(callsBefore, 0);
		});

		it("uninstall removes every handler so re-installing works cleanly", () => {
			setTTY(true);
			enterAltScreen();
			uninstall = installAltScreenSafetyNet();
			uninstall();
			uninstall = null;

			written.length = 0;
			const callsBefore = exitSpy.mock.calls.length;

			process.emit("SIGINT");

			// No safety-net handler installed → our code didn't write the
			// exit sequence and didn't bump exit. (`entered` was reset in
			// afterEach of the previous test, so even if a handler were
			// still around it would no-op.)
			expect(written).toEqual([]);
			expectDelta(callsBefore, 0);
		});
	});
});

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import process from "node:process";
import {
	__resetMouseModeForTests,
	enterMouseMode,
	exitMouseMode,
	isMouseModeEnabled,
	toggleMouseMode,
} from "../src/mouseMode";

const ENABLE_MOUSE = "[?1000h[?1006h";
const DISABLE_MOUSE = "[?1006l[?1000l";

describe("mouseMode", () => {
	let stdoutSpy: ReturnType<typeof spyOn>;
	let written: string[];
	let originalStdoutIsTTY: boolean | undefined;
	let originalStdinIsTTY: boolean | undefined;

	beforeEach(() => {
		__resetMouseModeForTests();
		written = [];
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation(((
			chunk: string | Uint8Array,
			..._args: unknown[]
		) => {
			written.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		}) as never);
		originalStdoutIsTTY = process.stdout.isTTY;
		originalStdinIsTTY = process.stdin.isTTY;
	});

	afterEach(() => {
		stdoutSpy.mockRestore();
		__resetMouseModeForTests();
		setTTY(originalStdoutIsTTY, originalStdinIsTTY);
	});

	function setTTY(stdout: boolean | undefined, stdin: boolean | undefined) {
		Object.defineProperty(process.stdout, "isTTY", {
			value: stdout,
			configurable: true,
			writable: true,
		});
		Object.defineProperty(process.stdin, "isTTY", {
			value: stdin,
			configurable: true,
			writable: true,
		});
	}

	describe("enterMouseMode", () => {
		it("enables normal tracking plus SGR coordinates when both streams are TTYs", () => {
			setTTY(true, true);
			expect(enterMouseMode()).toBe(true);
			expect(written).toEqual([ENABLE_MOUSE]);
		});

		it("is a no-op when stdout is not a TTY", () => {
			setTTY(false, true);
			expect(enterMouseMode()).toBe(false);
			expect(written).toEqual([]);
		});

		it("is a no-op when stdin is not a TTY — nothing could deliver the reports", () => {
			setTTY(true, false);
			expect(enterMouseMode()).toBe(false);
			expect(written).toEqual([]);
		});

		it("is idempotent", () => {
			setTTY(true, true);
			enterMouseMode();
			enterMouseMode();
			expect(written).toEqual([ENABLE_MOUSE]);
		});
	});

	describe("exitMouseMode", () => {
		it("is a no-op when we never entered", () => {
			setTTY(true, true);
			exitMouseMode();
			expect(written).toEqual([]);
		});

		it("disables the modes in reverse order", () => {
			setTTY(true, true);
			enterMouseMode();
			written.length = 0;
			exitMouseMode();
			expect(written).toEqual([DISABLE_MOUSE]);
		});

		it("is idempotent — a leaked ?1006h would spew bytes into the user's shell", () => {
			setTTY(true, true);
			enterMouseMode();
			exitMouseMode();
			exitMouseMode();
			expect(written).toEqual([ENABLE_MOUSE, DISABLE_MOUSE]);
		});

		it("allows re-entry after exit", () => {
			setTTY(true, true);
			enterMouseMode();
			exitMouseMode();
			written.length = 0;
			enterMouseMode();
			expect(written).toEqual([ENABLE_MOUSE]);
		});
	});

	describe("isMouseModeEnabled", () => {
		it("starts false and tracks enterMouseMode / exitMouseMode", () => {
			setTTY(true, true);
			expect(isMouseModeEnabled()).toBe(false);
			enterMouseMode();
			expect(isMouseModeEnabled()).toBe(true);
			exitMouseMode();
			expect(isMouseModeEnabled()).toBe(false);
		});
	});

	describe("toggleMouseMode", () => {
		it("flips from off to on and returns the new state", () => {
			setTTY(true, true);
			expect(toggleMouseMode()).toBe(true);
			expect(isMouseModeEnabled()).toBe(true);
			expect(written).toEqual([ENABLE_MOUSE]);
		});

		it("flips from on to off and returns the new state", () => {
			setTTY(true, true);
			enterMouseMode();
			written.length = 0;
			expect(toggleMouseMode()).toBe(false);
			expect(isMouseModeEnabled()).toBe(false);
			expect(written).toEqual([DISABLE_MOUSE]);
		});

		it("flips back and forth across consecutive toggles", () => {
			setTTY(true, true);
			toggleMouseMode(); // on
			toggleMouseMode(); // off
			toggleMouseMode(); // on
			expect(isMouseModeEnabled()).toBe(true);
			expect(written).toEqual([ENABLE_MOUSE, DISABLE_MOUSE, ENABLE_MOUSE]);
		});

		it("is a no-op when TTYs aren't attached", () => {
			setTTY(false, true);
			expect(toggleMouseMode()).toBe(false);
			expect(isMouseModeEnabled()).toBe(false);
			expect(written).toEqual([]);
		});
	});
});

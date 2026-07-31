import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import process from "node:process";
import { __resetAltScreenForTests, enterAltScreen, exitAltScreen } from "../src/altScreen";

const ENTER_ALT = "[?1049h[H";
const EXIT_ALT = "[?1049l";
const HIDE_CURSOR = "[?25l";
const SHOW_CURSOR = "[?25h";

describe("altScreen", () => {
	let stdoutSpy: ReturnType<typeof spyOn>;
	let written: string[];
	let originalIsTTY: boolean | undefined;

	beforeEach(() => {
		__resetAltScreenForTests();
		written = [];
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation(((
			chunk: string | Uint8Array,
			..._args: unknown[]
		) => {
			written.push(typeof chunk === "string" ? chunk : chunk.toString());
			return true;
		}) as never);
		originalIsTTY = process.stdout.isTTY;
	});

	afterEach(() => {
		stdoutSpy.mockRestore();
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
});

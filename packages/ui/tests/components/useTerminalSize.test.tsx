import { describe, expect, it } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { FALLBACK_TERMINAL_SIZE, useTerminalSize } from "../../src/useTerminalSize";

function Probe() {
	const { rows, columns } = useTerminalSize();
	return <Text>{`${rows}x${columns}`}</Text>;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("useTerminalSize", () => {
	it("falls back when the stream reports no size", async () => {
		// ink-testing-library's fake stdout exposes `columns` (100) but has no
		// `rows` at all, which is exactly the shape a non-TTY stream has.
		const { lastFrame } = render(<Probe />);
		await tick();
		expect(lastFrame()).toBe(`${FALLBACK_TERMINAL_SIZE.rows}x100`);
	});

	it("re-renders with the new size when the terminal is resized", async () => {
		const { lastFrame, stdout } = render(<Probe />);
		await tick();

		Object.defineProperty(stdout, "rows", { value: 40, configurable: true });
		Object.defineProperty(stdout, "columns", { value: 55, configurable: true });
		stdout.emit("resize");
		await tick();

		expect(lastFrame()).toBe("40x55");
	});

	it("treats a zero-sized stream as unsized", async () => {
		const { lastFrame, stdout } = render(<Probe />);
		await tick();

		// Non-TTY streams report 0, not undefined — `??` would let the 0 through.
		Object.defineProperty(stdout, "rows", { value: 0, configurable: true });
		Object.defineProperty(stdout, "columns", { value: 0, configurable: true });
		stdout.emit("resize");
		await tick();

		expect(lastFrame()).toBe(`${FALLBACK_TERMINAL_SIZE.rows}x${FALLBACK_TERMINAL_SIZE.columns}`);
	});

	it("removes its resize listener on unmount", async () => {
		const { stdout, unmount } = render(<Probe />);
		await tick();
		// On macOS ink-testing-library's mock stdout also subscribes to its
		// own 'resize' event, so we see >= 2. On Linux + GitHub Actions the
		// mock stream doesn't, so the only listener present is ours. The
		// invariant we actually want to assert is "our hook added a listener
		// and then removed it" — that's >= 1 before unmount, === 0 after.
		const mounted = stdout.listenerCount("resize");
		expect(mounted).toBeGreaterThanOrEqual(1);

		unmount();
		await tick();
		expect(stdout.listenerCount("resize")).toBe(0);
	});
});

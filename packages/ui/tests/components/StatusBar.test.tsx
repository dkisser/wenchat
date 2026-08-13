import { describe, expect, it } from "bun:test";
import { Box } from "ink";
import { render } from "ink-testing-library";
import { StatusBar } from "../../src/StatusBar";

describe("StatusBar", () => {
	it("renders online status with peer name", () => {
		const { lastFrame } = render(<StatusBar status="online" peerName="bob" />);
		expect(lastFrame()).toContain("bob");
	});

	it("renders peer endpoint alongside name when connected", () => {
		const { lastFrame } = render(
			<StatusBar status="online" peerName="bob" peerEndpoint="192.168.1.42:8001" />,
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("bob");
		expect(frame).toContain("192.168.1.42:8001");
	});

	it("omits endpoint when not connected", () => {
		const { lastFrame } = render(<StatusBar status="offline" />);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("Offline");
		// No host:port pattern should appear.
		expect(frame).not.toMatch(/\d+\.\d+\.\d+\.\d+:\d+/);
	});

	it("appends a hint after the status word when one is given", () => {
		const { lastFrame } = render(<StatusBar status="offline" hint="Pick a bind address" />);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("Offline");
		expect(frame).toContain("Pick a bind address");
		// Still one row — the hint shares the status line rather than adding one.
		expect(frame.split("\n").length).toBe(1);
	});

	it("renders without a border so it costs only one row", () => {
		// The status bar used to be a bordered Box, which consumed three rows
		// (border + text + border) and visually sandwiched the chat top
		// border between two more box-drawing rows. Flattening it halved the
		// visual gap and reclaimed two rows for the chat viewport.
		const { lastFrame } = render(<StatusBar status="offline" />);
		const frame = lastFrame() ?? "";
		expect(frame.split("\n").length).toBe(1);
		expect(frame).not.toContain("│");
		expect(frame).not.toContain("─");
	});

	it("pads the text on the left to match the chat view's paddingX={1}", () => {
		// ink only honours `paddingLeft` when the Box has a fixed parent
		// width to pad within. The real CLI mounts StatusBar under a
		// column-flex root sized to the terminal, so simulate that here.
		const { lastFrame } = render(
			<Box flexDirection="column" width={80}>
				<StatusBar status="offline" />
			</Box>,
		);
		const frame = lastFrame() ?? "";
		// First char is the padding space; the Offline text comes after the
		// ANSI colour sequence Ink wraps it in.
		expect(frame.startsWith(" ")).toBe(true);
		expect(frame).toContain("Offline");
	});

	it("renders a toast on the right edge without growing the line", () => {
		const { lastFrame } = render(
			<Box flexDirection="column" width={80}>
				<StatusBar status="online" toast={{ text: "Copied" }} />
			</Box>,
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("Copied");
		// Toast is in-row, not a second line.
		expect(frame.split("\n").length).toBe(1);
	});

	it("does not render the toast slot when toast is null/undefined", () => {
		const { lastFrame } = render(<StatusBar status="online" />);
		expect(lastFrame()).not.toContain("Copied");
	});

	it("styles error-tone toasts in red", () => {
		const { lastFrame } = render(
			<StatusBar status="online" toast={{ text: "Copy failed", tone: "error" }} />,
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("Copy failed");
		// ANSI red is "\x1b[31m"; gray would be "\x1b[90m" — make sure we
		// emitted the red escape specifically.
		expect(frame).toContain("\x1b[31m");
	});
});

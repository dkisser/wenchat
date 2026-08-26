import { describe, expect, it } from "bun:test";
import chalk from "chalk";
import { Box } from "ink";
import { render } from "ink-testing-library";
import { StatusBar } from "../../src/StatusBar";

// Force chalk to emit ANSI escape codes regardless of the runner's TTY
// detection. On GitHub Actions `process.stdout.isTTY` is false (and
// `CI=true` is set), so chalk/ink would otherwise strip the `\x1b[31m`
// red escape this test depends on. Setting `chalk.level = 1` is the
// direct knob (chalk 5+ reads it lazily on every colour call); the
// FORCE_COLOR env var is left alone for any other consumer.
chalk.level = 1;

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
		const { lastFrame } = render(
			<StatusBar status="offline" hint="Pick a bind address" version="dev" />,
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("Offline");
		expect(frame).toContain("Pick a bind address");
		expect(frame).toContain("dev");
		// Still one row — the hint and version share the status line.
		expect(frame.split("\n").length).toBe(1);
	});

	it("renders the version when provided", () => {
		const { lastFrame } = render(
			<Box flexDirection="column" width={80}>
				<StatusBar status="offline" version="v0.1.3" />
			</Box>,
		);
		expect(lastFrame()).toContain("v0.1.3");
	});

	it("omits the version segment when version is undefined", () => {
		const { lastFrame } = render(
			<Box flexDirection="column" width={80}>
				<StatusBar status="offline" />
			</Box>,
		);
		expect(lastFrame()).not.toContain("v0.");
		expect(lastFrame()).not.toContain("dev");
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

	it("renders 'Reconnecting to <name>...' when reconnecting", () => {
		const { lastFrame } = render(
			<StatusBar status="reconnecting" peerName="bob" peerEndpoint="10.0.0.5:9001" />,
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("Reconnecting");
		expect(frame).toContain("bob");
		// Endpoint is not displayed in the reconnecting line — name is the
		// more user-friendly identifier; the endpoint lives in chat log
		// system messages instead.
		expect(frame).not.toContain("10.0.0.5:9001");
	});

	it("falls back to endpoint when peerName is missing in reconnecting state", () => {
		const { lastFrame } = render(<StatusBar status="reconnecting" peerEndpoint="10.0.0.5:9001" />);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("Reconnecting");
		expect(frame).toContain("10.0.0.5:9001");
	});

	it("styles reconnecting in yellow like connecting", () => {
		const { lastFrame } = render(<StatusBar status="reconnecting" />);
		const frame = lastFrame() ?? "";
		// ANSI yellow is "\x1b[33m"; gray would be "\x1b[90m".
		expect(frame).toContain("\x1b[33m");
		expect(frame).not.toContain("\x1b[90m");
	});
});

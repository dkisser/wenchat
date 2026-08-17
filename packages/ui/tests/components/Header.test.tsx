import { describe, expect, it } from "bun:test";
import chalk from "chalk";
import { Box } from "ink";
import { render } from "ink-testing-library";
import { Header } from "../../src/Header";
import { LOGO_LINES } from "../../src/logo";

// Same rationale as StatusBar.test.tsx: force chalk to emit ANSI escapes
// even when the runner's stdout is not a TTY (CI).
chalk.level = 1;

describe("Header", () => {
	it("renders every wordmark line", () => {
		const { lastFrame } = render(<Header status="offline" localName="alice" />);
		const frame = lastFrame() ?? "";
		for (const line of LOGO_LINES) {
			expect(frame).toContain(line);
		}
	});

	it("renders the status text shared with StatusBar", () => {
		const { lastFrame } = render(
			<Header status="online" peerName="bob" peerEndpoint="192.168.1.42:8001" localName="alice" />,
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("Online");
		expect(frame).toContain("bob");
		expect(frame).toContain("192.168.1.42:8001");
	});

	it("shows the local identity line with endpoint and version", () => {
		const { lastFrame } = render(
			<Header status="offline" localName="alice" localEndpoint="192.168.1.10:7001" version="dev" />,
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("You: alice");
		expect(frame).toContain("192.168.1.10:7001");
		expect(frame).toContain("dev");
	});

	it("omits the endpoint segment until the listener is bound", () => {
		const { lastFrame } = render(<Header status="offline" localName="alice" />);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("You: alice");
		expect(frame).not.toMatch(/\d+\.\d+\.\d+\.\d+:\d+/);
	});

	it("always carries the double-click copy hint", () => {
		const { lastFrame } = render(<Header status="offline" localName="alice" />);
		expect(lastFrame()).toContain("Double-click to copy");
	});

	it("adds the select-mode reminder while mouse reporting is off", () => {
		const { lastFrame } = render(
			<Header status="offline" localName="alice" mouseEnabled={false} />,
		);
		expect(lastFrame()).toContain("Select mode (Ctrl+T)");
	});

	it("renders a toast at the right edge of the status row", () => {
		const { lastFrame } = render(
			<Box flexDirection="column" width={100}>
				<Header status="online" localName="alice" toast={{ text: "Copied: hello" }} />
			</Box>,
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("Copied: hello");
		// Toast shares the status row: the frame is still exactly the four
		// wordmark rows tall — the layout math in chatLayout.ts depends on it.
		expect(frame.split("\n").length).toBe(4);
	});

	it("stays exactly four rows tall with all slots filled", () => {
		const { lastFrame } = render(
			<Box flexDirection="column" width={100}>
				<Header
					status="online"
					peerName="bob"
					peerEndpoint="192.168.1.42:8001"
					localName="alice"
					localEndpoint="192.168.1.10:7001"
					version="v0.1.3"
					mouseEnabled={false}
					toast={{ text: "Copied", tone: "error" }}
				/>
			</Box>,
		);
		expect((lastFrame() ?? "").split("\n").length).toBe(4);
	});

	it("styles error-tone toasts in red", () => {
		const { lastFrame } = render(
			<Header status="online" localName="alice" toast={{ text: "Copy failed", tone: "error" }} />,
		);
		expect(lastFrame()).toContain("\x1b[31m");
	});
});

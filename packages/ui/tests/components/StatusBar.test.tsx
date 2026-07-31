import { describe, expect, it } from "bun:test";
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
});

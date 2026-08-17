import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import { PeerList } from "../../src/PeerList";

describe("PeerList", () => {
	it("renders peer names", () => {
		const peers = [
			{
				id: "p1",
				displayName: "bob",
				signalingHost: "127.0.0.1",
				signalingPort: 9001,
			},
		];
		const { lastFrame } = render(<PeerList peers={peers} onSelect={() => {}} />);
		expect(lastFrame()).toContain("bob");
	});

	it("never grows past the height it is given", () => {
		const peers = Array.from({ length: 50 }, (_, index) => ({
			id: `p${index}`,
			displayName: `peer-${index}`,
			signalingHost: "127.0.0.1",
			signalingPort: 9000 + index,
		}));
		const { lastFrame } = render(<PeerList peers={peers} onSelect={() => {}} height={10} />);
		const frame = lastFrame() ?? "";
		expect(frame.split("\n").length).toBe(10);
		// Borderless, like the ChatView it shares the middle pane with.
		expect(frame).not.toContain("│");
		// The selection starts at the first peer, so the window sticks to the top.
		expect(frame).toContain("peer-0");
		expect(frame).not.toContain("peer-49");
	});
});

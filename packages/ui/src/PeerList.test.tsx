import { render } from "ink-testing-library";
import { describe, expect, it } from "bun:test";
import React from "react";
import { PeerList } from "./PeerList.tsx";

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
});

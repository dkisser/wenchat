import { describe, expect, it } from "bun:test";
import { PeerConnection } from "./peer";

describe("PeerConnection", () => {
	it("creates a peer connection", () => {
		const peer = new PeerConnection();
		expect(peer).toBeDefined();
		peer.close();
	});
});

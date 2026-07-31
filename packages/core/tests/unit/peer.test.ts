import { describe, expect, it } from "bun:test";
import { type IncomingOfferInfo, PeerConnection } from "../../src/peer";

describe("PeerConnection", () => {
	it("creates a peer connection", () => {
		const peer = new PeerConnection();
		expect(peer).toBeDefined();
		peer.close();
	});

	it("onIncoming fires with the initiator's host/port when an offer arrives", async () => {
		const alice = new PeerConnection();
		const bob = new PeerConnection();
		try {
			await alice.startListening(0);
			await bob.startListening(0);

			const received: IncomingOfferInfo[] = [];
			const unsub = bob.onIncoming((info) => received.push(info));

			await alice.connect("127.0.0.1", bob.getSignalingPort());

			expect(received.length).toBeGreaterThanOrEqual(1);
			expect(received[0].signalingHost).toBe("127.0.0.1");
			expect(received[0].signalingPort).toBe(alice.getSignalingPort());

			unsub();
		} finally {
			alice.close();
			bob.close();
		}
	});

	it("onIncoming unsubscribe stops further notifications", async () => {
		const alice = new PeerConnection();
		const bob = new PeerConnection();
		try {
			await alice.startListening(0);
			await bob.startListening(0);

			const received: IncomingOfferInfo[] = [];
			const unsub = bob.onIncoming((info) => received.push(info));
			unsub();

			await alice.connect("127.0.0.1", bob.getSignalingPort());
			expect(received.length).toBe(0);
		} finally {
			alice.close();
			bob.close();
		}
	});
});

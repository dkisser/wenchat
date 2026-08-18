import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { RTCPeerConnection } from "werift";
import { Session } from "../../src/session";
import type { SignalingServer } from "../../src/signaling";

/**
 * Regression tests for the handshake-failure leak: a pc created inside
 * `initiate`/`accept` holds a UDP socket and ICE gathering state, so a
 * throw anywhere after `installPeerConnection` must still close it.
 * Observed via a spy on `RTCPeerConnection.prototype.close` (asserted
 * with `toHaveBeenCalled` — werift may close internally on top of the
 * session's own cleanup call).
 */
describe("Session handshake cleanup", () => {
	let closeSpy: ReturnType<typeof spyOn>;

	afterEach(() => {
		closeSpy?.mockRestore();
	});

	it("initiate closes the pc when the offer cannot be delivered", async () => {
		closeSpy = spyOn(RTCPeerConnection.prototype, "close");
		const signaling = {
			sendOffer: async () => {
				throw new Error("peer offline");
			},
			sendCandidate: async () => {},
		} as unknown as SignalingServer;

		await expect(
			Session.initiate({
				signaling,
				localHost: "127.0.0.1",
				localPort: 1,
				remoteHost: "127.0.0.1",
				remotePort: 2,
			}),
		).rejects.toThrow("peer offline");
		expect(closeSpy).toHaveBeenCalled();
	});

	it("accept closes the pc when the offer cannot be applied", async () => {
		closeSpy = spyOn(RTCPeerConnection.prototype, "close");
		// werift's setRemoteDescription tolerates garbage SDP, so force the
		// failure at the seam itself.
		const original = RTCPeerConnection.prototype.setRemoteDescription;
		RTCPeerConnection.prototype.setRemoteDescription = (() =>
			Promise.reject(new Error("bad offer"))) as never;
		const signaling = { sendCandidate: async () => {} } as unknown as SignalingServer;

		try {
			await expect(
				Session.accept({
					signaling,
					localHost: "127.0.0.1",
					localPort: 1,
					offer: { type: "offer", sdp: "v=0", signalingHost: "127.0.0.1", signalingPort: 2 },
				}),
			).rejects.toThrow("bad offer");
			expect(closeSpy).toHaveBeenCalled();
		} finally {
			RTCPeerConnection.prototype.setRemoteDescription = original;
		}
	});

	it("cleanup never masks the original handshake error", async () => {
		const signaling = {
			sendOffer: async () => {
				throw new Error("original failure");
			},
			sendCandidate: async () => {},
		} as unknown as SignalingServer;
		// Even if pc.close() itself throws during cleanup, the caller must
		// see the handshake error, not the cleanup error.
		const originalClose = RTCPeerConnection.prototype.close;
		let firstCall = true;
		RTCPeerConnection.prototype.close = function () {
			// Free the socket for real first — only the throw is simulated,
			// and only on the session's own cleanup call: werift's async
			// teardown may call close() again later, and a throw there would
			// escape as an uncaught error unrelated to this test's subject.
			originalClose.call(this);
			if (firstCall) {
				firstCall = false;
				throw new Error("cleanup exploded");
			}
		} as never;
		try {
			await expect(
				Session.initiate({
					signaling,
					localHost: "127.0.0.1",
					localPort: 1,
					remoteHost: "127.0.0.1",
					remotePort: 2,
				}),
			).rejects.toThrow("original failure");
		} finally {
			RTCPeerConnection.prototype.close = originalClose;
		}
	});
});

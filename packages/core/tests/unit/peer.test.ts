import { describe, expect, it } from "bun:test";
import { type IncomingOfferInfo, PeerConnection } from "../../src/peer";

// Linux kernel is stricter than macOS about UDP port-unreachable: a STUN
// packet landing on a peer socket that has already closed turns into an
// 'error' event on werift's dgram socket, which surfaces as an unhandled
// exception. macOS silently drops the ICMP. We install a process-level
// filter so the regression assertion (which is about state-change events,
// not transport health) stays focused on what it's testing.
const suppressUdpRefused = (): (() => void) => {
	const handler = (err: unknown): void => {
		const code = (err as { code?: string } | null)?.code;
		if (code === "ECONNREFUSED" || code === "EHOSTUNREACH") return;
		// Re-throw anything else so unrelated failures still surface.
		throw err;
	};
	process.on("uncaughtException", handler);
	return () => {
		process.off("uncaughtException", handler);
	};
};

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

	it("advertises the third argument instead of the bind address when they differ", async () => {
		// Wildcard bind: we listen on every NIC but must tell the peer a
		// concrete address, because "0.0.0.0" would resolve to the peer's own
		// loopback. The advertised host is the one that reaches onIncoming —
		// the bind address never leaves this process.
		const alice = new PeerConnection();
		const bob = new PeerConnection();
		try {
			await alice.startListening(0, "127.0.0.1", "10.9.9.9");
			await bob.startListening(0);

			const received: IncomingOfferInfo[] = [];
			const unsub = bob.onIncoming((info) => received.push(info));

			await alice.connect("127.0.0.1", bob.getSignalingPort());

			expect(received.length).toBeGreaterThanOrEqual(1);
			expect(received[0].signalingHost).toBe("10.9.9.9");

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

	describe("disconnect", () => {
		it("is a no-op when no session is active", () => {
			const peer = new PeerConnection();
			try {
				expect(() => peer.disconnect()).not.toThrow();
			} finally {
				peer.close();
			}
		});

		it("tears down the active session without notifying listeners", async () => {
			// Regression test: an earlier refactor detached forwarders but
			// then closed the session, which let pc.close()'s async
			// "closed" event race a fresh swapSession and surface a stale
			// "disconnected" to the app. After disconnect, the local app
			// should NOT observe a terminal state — that's what the
			// `/disconnect` magic command relies on for its own message.
			const restore = suppressUdpRefused();
			const alice = new PeerConnection();
			const bob = new PeerConnection();
			try {
				await alice.startListening(0);
				await bob.startListening(0);

				const states: string[] = [];
				alice.onStateChange((state) => states.push(state));
				await alice.connect("127.0.0.1", bob.getSignalingPort());

				// Wait for "connected" so we know the session is live.
				await waitForState(states, "connected");

				alice.disconnect();

				// Give the async pc.close() callback a tick to (incorrectly)
				// fire a terminal event into the listener.
				await new Promise((resolve) => setTimeout(resolve, 50));

				// The initiator side never emits a "connecting" state — it
				// jumps straight to "connected" once the answer SDP lands —
				// so the expected sequence is just the single connected.
				expect(states).toEqual(["connected"]);
			} finally {
				alice.close();
				bob.close();
				restore();
			}
		});

		it("leaves the signaling server alive so a new connect can succeed", async () => {
			const alice = new PeerConnection();
			const bob = new PeerConnection();
			try {
				await alice.startListening(0);
				await bob.startListening(0);

				const bobPort = bob.getSignalingPort();
				await alice.connect("127.0.0.1", bobPort);
				alice.disconnect();

				// A second dial should still succeed — the signaling server
				// is what carries the offer/answer exchange, and disconnect
				// only tears down the active session.
				await alice.connect("127.0.0.1", bobPort);
			} finally {
				alice.close();
				bob.close();
			}
		});
	});
});

async function waitForState(states: string[], target: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (states.includes(target)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for state "${target}", saw: ${states.join(",")}`);
}

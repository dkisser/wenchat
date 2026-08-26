import { describe, expect, it } from "bun:test";
import { type IncomingOfferInfo, PeerConnection } from "../../src/peer";
import { suppressUdpRefused } from "../helpers/udpSuppression";

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
			const restore = suppressUdpRefused();
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
				restore();
			}
		});
	});

	describe("network-driven pc close", () => {
		// Regression: after the user's pc drops without a local
		// `/disconnect` (Wi-Fi blip, peer process dies, ICE failure), the
		// app must be able to dial again on the same `PeerConnection`
		// without restarting the process. The signaling server is the
		// long-lived component; the dead pc should be swapped out for a
		// fresh one on the next `connect()`.
		//
		// The app must also release the dead session's UDP/STUN resources
		// (transport + heartbeat) before the next `connect()` — leaving
		// them open pins werift's socket state and the new pc's ICE stalls
		// in "checking" indefinitely. `closeActiveSession()` is the
		// post-terminal-state hook for that.
		it("can reconnect on the same PeerConnection after a network-driven close", async () => {
			const restore = suppressUdpRefused();
			const alice = new PeerConnection();
			const bob = new PeerConnection();
			try {
				await alice.startListening(0);
				await bob.startListening(0);

				const states: string[] = [];
				alice.onStateChange((state) => states.push(state));

				// First handshake.
				await alice.connect("127.0.0.1", bob.getSignalingPort());
				await waitForState(states, "connected");

				// Simulate abrupt network death on alice's side. Unlike
				// `disconnect()` (which detaches the forwarders first),
				// `_forceClosePc()` is the raw escape hatch that lets
				// pc.close()'s terminal event reach our listener — that's
				// the path the reconnect logic in App.tsx has to handle.
				alice._forceCloseActivePc();
				await waitForAnyState(states, ["disconnected", "closed", "failed"]);

				// Release the dead session's transport + heartbeat so the
				// next handshake's UDP/STUN resources don't collide with
				// the closed pc's leftovers. Without this, the new pc's
				// ICE stalls in "checking" and never reaches "connected".
				alice.closeActiveSession();

				// `closeActiveSession` keeps the listeners wired (so a
				// late close on the dead pc still reaches the app — the
				// `terminated` flag suppresses that anyway). For the test
				// it means the dead pc's "closed" already counts toward
				// the state buffer; we re-subscribe a fresh listener for
				// the second session so we only count its "connected".
				const freshStates: string[] = [];
				const unsub = alice.onStateChange((s) => freshStates.push(s));

				// Second dial on the SAME PeerConnection — this is the
				// user-reported bug, in single-process form.
				await alice.connect("127.0.0.1", bob.getSignalingPort());
				await waitForCount(freshStates, "connected", 1, 5000);
				unsub();

				// Expect TWO "connected" emissions (one per Session).
				const connectedCount = states.filter((s) => s === "connected").length;
				expect(connectedCount).toBeGreaterThanOrEqual(2);
			} finally {
				alice.close();
				bob.close();
				restore();
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

async function waitForAnyState(
	states: string[],
	targets: readonly string[],
	timeoutMs = 2000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (states.some((s) => targets.includes(s))) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for one of [${targets.join(",")}], saw: ${states.join(",")}`);
}

async function waitForCount(
	states: string[],
	target: string,
	count: number,
	timeoutMs = 2000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (states.filter((s) => s === target).length >= count) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${count}×"${target}", saw: ${states.join(",")}`);
}

import { describe, expect, it } from "bun:test";
import type { ConnectionEvent } from "../../src/connectionState";
import { type IncomingOfferInfo, PeerConnection } from "../../src/peer";
import { countState, waitForClose, waitForCount, waitForState } from "../helpers/connectionEvents";
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

		it("emits a local-disconnect terminal event so the app can skip retrying", async () => {
			// Behaviour reversal: this used to assert the OPPOSITE — that a
			// manual `/disconnect` produced NO terminal event, because
			// `disconnect()` detached its forwarders before closing. That made
			// "was this intentional?" the *absence* of an event, a side
			// channel that could not express the remote case at all: a peer's
			// `/disconnect` looked exactly like a Wi-Fi drop, so the far end
			// burned a full reconnect-backoff window on a peer that had left.
			// The intent now travels WITH the event as a CloseReason.
			const restore = suppressUdpRefused();
			const alice = new PeerConnection();
			const bob = new PeerConnection();
			try {
				await alice.startListening(0);
				await bob.startListening(0);

				const events: ConnectionEvent[] = [];
				alice.onStateChange((event) => events.push(event));
				await alice.connect("127.0.0.1", bob.getSignalingPort());

				// Wait for "connected" so we know the session is live.
				await waitForState(events, "connected");

				alice.disconnect();

				expect(await waitForClose(events)).toBe("local-disconnect");
				// Exactly one terminal event: `Session.terminated` still
				// dedupes the async pc.close() callback that follows.
				await new Promise((resolve) => setTimeout(resolve, 50));
				expect(countState(events, "closed")).toBe(1);
			} finally {
				alice.close();
				bob.close();
				restore();
			}
		});

		it("sends a bye before closing so the peer learns the teardown was deliberate", async () => {
			const restore = suppressUdpRefused();
			const alice = new PeerConnection();
			const bob = new PeerConnection();
			try {
				await alice.startListening(0);
				await bob.startListening(0);

				const bobEvents: ConnectionEvent[] = [];
				bob.onStateChange((event) => bobEvents.push(event));
				await alice.connect("127.0.0.1", bob.getSignalingPort());
				await waitForState(bobEvents, "connected", 5000);

				await alice.closeGracefully("local-disconnect");

				expect(await waitForClose(bobEvents, 5000)).toBe("remote-disconnect");
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

				const events: ConnectionEvent[] = [];
				alice.onStateChange((event) => events.push(event));

				// First handshake.
				await alice.connect("127.0.0.1", bob.getSignalingPort());
				await waitForState(events, "connected");

				// Simulate abrupt network death on alice's side. Unlike
				// `closeGracefully()` (which sends a bye first), this is the
				// raw escape hatch: no intent reaches the wire, so the
				// terminal event carries reason "network" — the one case the
				// reconnect logic in App.tsx is allowed to retry.
				alice._forceCloseActivePc();
				expect(await waitForClose(events)).toBe("network");

				// Release the dead session's transport + heartbeat so the
				// next handshake's UDP/STUN resources don't collide with
				// the closed pc's leftovers. Without this, the new pc's
				// ICE stalls in "checking" and never reaches "connected".
				alice.closeActiveSession();

				// `closeActiveSession` keeps the listeners wired (so a
				// late close on the dead pc still reaches the app — the
				// `terminated` flag suppresses that anyway). For the test
				// it means the dead pc's "closed" already counts toward
				// the event buffer; we re-subscribe a fresh listener for
				// the second session so we only count its "connected".
				const freshEvents: ConnectionEvent[] = [];
				const unsub = alice.onStateChange((e) => freshEvents.push(e));

				// Second dial on the SAME PeerConnection — this is the
				// user-reported bug, in single-process form.
				await alice.connect("127.0.0.1", bob.getSignalingPort());
				await waitForCount(freshEvents, "connected", 1, 5000);
				unsub();

				// Expect TWO "connected" emissions (one per Session).
				expect(countState(events, "connected")).toBeGreaterThanOrEqual(2);
			} finally {
				alice.close();
				bob.close();
				restore();
			}
		});
	});
});

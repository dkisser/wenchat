import type { Message } from "@wenchat/protocol";
import { Session } from "./session";
import { type IceCandidatePayload, type SdpPayload, SignalingServer } from "./signaling";

/**
 * Information surfaced to app code when a remote peer sends an offer
 * to our signaling server (i.e. we are the receiver).
 *
 * `signalingHost` / `signalingPort` come straight from the offer
 * payload's `signalingHost` / `signalingPort` fields — the initiator
 * populated them so it could be reached for ICE candidate exchange.
 * If the offer carried no endpoint (older protocol), both fields are
 * the empty / zero defaults; app code is responsible for deciding how
 * to label an unidentified peer.
 */
export type IncomingOfferInfo = {
	readonly signalingHost: string;
	readonly signalingPort: number;
};

/**
 * LAN-only peer connection.
 *
 * Owns the long-lived signaling server (process-lifetime) and a single
 * active `Session` (one handshake). Each `connect()` / `acceptOffer()`
 * call constructs a fresh `Session`; the previous one — if any — is
 * closed and dereferenced. App-facing API stays the same; only the
 * underlying object graph has changed.
 */
export class PeerConnection {
	private signaling: SignalingServer;
	private session?: Session;
	// Forwarders from the active session's events into our own
	// listener sets. Each swap unsubscribes the previous batch so a
	// stale pc firing `closed` after we've moved on cannot leak a
	// terminal event into the listener fan-out.
	private sessionUnsubscribers: Array<() => void> = [];

	// Tiny candidate buffer for the brief window between
	// `/offer` arriving and the new Session being installed. Node's
	// HTTP server can interleave handlers on a single async chain, so
	// `/candidate` POSTs can land BEFORE `Session.accept()` resolves
	// and wires up `this.session`. Without this buffer those
	// candidates would be discarded silently and ICE could never
	// complete on the very first handshake. Drained on every swap.
	private pendingCandidates: IceCandidatePayload[] = [];

	private messageListeners: Set<(message: Message) => void> = new Set();
	private stateListeners: Set<(state: string) => void> = new Set();
	private incomingListeners: Set<(info: IncomingOfferInfo) => void> = new Set();

	// The host:port we tell the remote peer to use when signaling back
	// to us. Defaults to loopback but LAN-mode callers override it.
	private localSignalingHost = "127.0.0.1";

	constructor() {
		this.signaling = new SignalingServer();
	}

	/**
	 * Start the signaling server.
	 *
	 * `signalingHost` is the *bind* address; `advertiseHost` is what we tell
	 * peers to dial back on. They are the same for a concrete address, and
	 * differ only when binding the `0.0.0.0` wildcard — a peer handed
	 * `"0.0.0.0"` would resolve it to its own loopback, so callers pass the
	 * LAN IPv4 (see `resolveAdvertiseHost`) as the third argument. Defaulting
	 * `advertiseHost` to `signalingHost` keeps every existing two-argument
	 * call site behaving exactly as before.
	 */
	async startListening(
		signalingPort: number,
		signalingHost = "127.0.0.1",
		advertiseHost = signalingHost,
	): Promise<void> {
		this.localSignalingHost = advertiseHost;
		await this.signaling.start(signalingPort, signalingHost);

		this.signaling.onOffer(async (offer) => {
			// Fire incoming listeners SYNCHRONOUSLY before awaiting
			// Session.accept. App code uses this to seed `selectedPeer`
			// ahead of the WebRTC `connected` state so the
			// "Connected to …" system-message path sees a peer and the
			// StatusBar carries the peer's name. Firing after
			// `Session.accept` would let werift schedule
			// `onconnectionstatechange` first, racing the React state
			// update and producing a silent receiver.
			const info: IncomingOfferInfo = {
				signalingHost: offer.signalingHost ?? "",
				signalingPort: offer.signalingPort ?? 0,
			};
			for (const listener of this.incomingListeners) {
				listener(info);
			}

			const newSession = await Session.accept({
				signaling: this.signaling,
				localHost: this.localSignalingHost,
				localPort: this.signaling.getPort(),
				offer,
			});
			this.swapSession(newSession);
			return { type: "answer", sdp: newSession.answerSdp ?? "" };
		});

		this.signaling.onCandidate((candidate) => {
			if (this.session) {
				void this.session.addIceCandidate(candidate);
			} else {
				this.pendingCandidates = [...this.pendingCandidates, candidate];
			}
		});
	}

	getSignalingPort(): number {
		return this.signaling.getPort();
	}

	async connect(peerHost: string, peerPort: number): Promise<void> {
		const newSession = await Session.initiate({
			signaling: this.signaling,
			localHost: this.localSignalingHost,
			localPort: this.signaling.getPort(),
			remoteHost: peerHost,
			remotePort: peerPort,
		});
		this.swapSession(newSession);
	}

	send(message: Message): void {
		if (!this.session) {
			throw new Error("Data channel not ready");
		}
		this.session.send(message);
	}

	onMessage(callback: (message: Message) => void): () => void {
		this.messageListeners.add(callback);
		return () => {
			this.messageListeners.delete(callback);
		};
	}

	onStateChange(callback: (state: string) => void): () => void {
		this.stateListeners.add(callback);
		return () => {
			this.stateListeners.delete(callback);
		};
	}

	/**
	 * Fired synchronously inside the signaling `/offer` handler, before
	 * `Session.accept` resolves. Carries the initiator's signaling
	 * endpoint (from the offer payload) so app code can identify the
	 * remote peer and prepare UI state ahead of the WebRTC `connected`
	 * event.
	 */
	onIncoming(callback: (info: IncomingOfferInfo) => void): () => void {
		this.incomingListeners.add(callback);
		return () => {
			this.incomingListeners.delete(callback);
		};
	}

	close(): void {
		// Detach forwarders BEFORE closing the session so a "closed"
		// event fired during teardown doesn't reach our listeners.
		this.detachActiveSession();
		this.signaling.stop().catch(() => {});
	}

	/**
	 * Close the active session (if any) without tearing down the signaling
	 * server. After this returns, the peer can still place outgoing calls
	 * via {@link connect} or accept incoming offers. Safe to call when no
	 * session is active — it's a no-op in that case.
	 *
	 * Detaches the forwarders BEFORE closing the session so a "closed" event
	 * fired during async pc teardown doesn't reach our listeners (which
	 * would otherwise flip the local UI to "Lost connection to …" for a
	 * disconnect the local user just initiated).
	 */
	disconnect(): void {
		this.detachActiveSession();
	}

	private detachActiveSession(): void {
		for (const unsubscribe of this.sessionUnsubscribers) {
			unsubscribe();
		}
		this.sessionUnsubscribers = [];

		this.session?.close();
		this.session = undefined;
	}

	/**
	 * Test-only escape hatch: forcibly close the underlying pc to
	 * simulate abrupt process death without going through the graceful
	 * shutdown path.
	 */
	_forceCloseActivePc(): void {
		this.session?._forceClosePc();
	}

	private swapSession(newSession: Session): void {
		// 1. Detach the forwarders from the outgoing session so any
		// late events on its pc are dropped at the session boundary.
		for (const unsubscribe of this.sessionUnsubscribers) {
			unsubscribe();
		}
		this.sessionUnsubscribers = [];

		// 2. Close the outgoing session locally. The old pc's
		// transport state was rejected by ICE in the previous
		// handshake; tearing it down here keeps the underlying
		// UDP/STUN resources from lingering as zombies that interfere
		// with the new session's gatherCandidates.
		const outgoing = this.session;
		this.session = newSession;
		if (outgoing && outgoing !== newSession) {
			outgoing.close();
		}

		// 3. Wire the new session's events into our listener sets.
		this.sessionUnsubscribers.push(
			newSession.onMessage((message) => {
				for (const listener of this.messageListeners) {
					listener(message);
				}
			}),
			newSession.onStateChange((state) => {
				for (const listener of this.stateListeners) {
					listener(state);
				}
			}),
		);

		// 4. Drain any candidates that arrived during the gap between
		// `/offer` and now. The session's `addIceCandidate` will queue
		// them itself if it hasn't set its remote description yet, so
		// calling it now is safe.
		if (this.pendingCandidates.length > 0) {
			const carry = this.pendingCandidates;
			this.pendingCandidates = [];
			for (const candidate of carry) {
				void newSession.addIceCandidate(candidate);
			}
		}
	}
}

// Re-export `SdpPayload` so existing consumers don't have to reach into
// `./signaling` directly.
export type { SdpPayload };

import type { Message } from "@wenchat/protocol";
import { Session } from "./session";
import { type IceCandidatePayload, type SdpPayload, SignalingServer } from "./signaling";

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

	// The host:port we tell the remote peer to use when signaling back
	// to us. Defaults to loopback but LAN-mode callers override it.
	private localSignalingHost = "127.0.0.1";

	constructor() {
		this.signaling = new SignalingServer();
	}

	async startListening(signalingPort: number, signalingHost = "127.0.0.1"): Promise<void> {
		this.localSignalingHost = signalingHost;
		await this.signaling.start(signalingPort, signalingHost);

		this.signaling.onOffer(async (offer) => {
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

	close(): void {
		// Detach forwarders BEFORE closing the session so a "closed"
		// event fired during teardown doesn't reach our listeners.
		for (const unsubscribe of this.sessionUnsubscribers) {
			unsubscribe();
		}
		this.sessionUnsubscribers = [];

		this.session?.close();
		this.session = undefined;

		this.signaling.stop().catch(() => {});
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

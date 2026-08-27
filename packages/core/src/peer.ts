import type { FileChunkFramePayload, Message } from "@wenchat/protocol";
import type { ConnectionEvent } from "./connectionState";
import type { SendFileOptions, SendFileResult } from "./fileTransfer";
import { getLogger } from "./logger";
import { Session } from "./session";
import { type IceCandidatePayload, type SdpPayload, SignalingServer } from "./signaling";

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Upper bound on how long a graceful close waits for the `bye` to leave the
 * data channel before killing the pc under it. `sendBye` only queues bytes
 * in werift's channel; `pc.close()` right after would discard them, and a
 * dropped `bye` means the peer falls back to auto-redialing a peer that
 * deliberately left — an intermittent version of the very bug this fixes.
 * On a LAN the flush is sub-millisecond, so this ceiling is pure insurance.
 */
const BYE_FLUSH_TIMEOUT_MS = 200;

/**
 * How long to let a still-negotiating data channel come up before giving up
 * on the `bye`. `connect()` resolves once the answer SDP is applied, which
 * can be before SCTP has the channel open — a `/disconnect` inside that
 * window would otherwise drop the bye and leave the peer redialing us.
 */
const BYE_OPEN_TIMEOUT_MS = 200;

/** Poll interval for the flush wait — short, since we expect one tick at most. */
const BYE_FLUSH_POLL_MS = 5;

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
	private chunkListeners: Set<(chunk: FileChunkFramePayload) => void> = new Set();
	private stateListeners: Set<(event: ConnectionEvent) => void> = new Set();
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
				try {
					listener(info);
				} catch (err) {
					// A throwing app listener must not abort the accept — the
					// remote peer is still waiting for its answer.
					getLogger().error({ err: errorText(err) }, "incoming listener threw");
				}
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

	/**
	 * Stream a file to the connected peer. Throws "Data channel not ready"
	 * when no session is active. See `fileTransfer.ts` for the wire flow.
	 */
	async sendFile(path: string, options?: SendFileOptions): Promise<SendFileResult> {
		if (!this.session) {
			throw new Error("Data channel not ready");
		}
		return this.session.sendFile(path, options);
	}

	onMessage(callback: (message: Message) => void): () => void {
		this.messageListeners.add(callback);
		return () => {
			this.messageListeners.delete(callback);
		};
	}

	/**
	 * Fires per inbound file chunk with the raw decoded frame payload.
	 * Kept off the `onMessage` stream so no synthetic id/timestamp is ever
	 * invented for data the wire doesn't carry.
	 */
	onFileChunk(callback: (chunk: FileChunkFramePayload) => void): () => void {
		this.chunkListeners.add(callback);
		return () => {
			this.chunkListeners.delete(callback);
		};
	}

	onStateChange(callback: (event: ConnectionEvent) => void): () => void {
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

	/**
	 * Hard teardown: close the active session and stop the signaling server.
	 * Synchronous, so any queued `bye` may be discarded — use
	 * {@link closeGracefully} on the user-facing `/exit` path and keep this
	 * for unmount/cleanup, where the listeners are already detached and
	 * nobody is left to inform.
	 */
	close(): void {
		this.closeSession("local-exit");
		this.signaling.stop().catch(() => {});
	}

	/**
	 * Close the active session (if any) without tearing down the signaling
	 * server. After this returns, the peer can still place outgoing calls
	 * via {@link connect} or accept incoming offers. Safe to call when no
	 * session is active — it's a no-op in that case.
	 *
	 * The terminal event this produces DOES reach `onStateChange` listeners,
	 * carrying `reason: "local-disconnect"`. That is deliberate: an earlier
	 * version detached the forwarders first so a local teardown was invisible
	 * to the app, which meant "was this intentional?" was encoded as the
	 * absence of an event. That side channel could not express the remote
	 * case at all — a peer's `/disconnect` was indistinguishable from a
	 * Wi-Fi drop — so the reason now travels with the event instead.
	 */
	disconnect(): void {
		this.closeSession("local-disconnect");
	}

	/**
	 * Send a `bye`, give it a bounded window to leave the wire, then close.
	 * Use this wherever the peer should learn the teardown was intentional
	 * (`/exit`, `/disconnect`); it is the difference between the far end
	 * saying "they left" and burning a 28-second redial window.
	 *
	 * `stopSignaling` mirrors the {@link close} vs {@link disconnect} split.
	 */
	async closeGracefully(
		reason: "local-exit" | "local-disconnect",
		stopSignaling = reason === "local-exit",
	): Promise<void> {
		const session = this.session;
		if (session) {
			// A channel that is still "connecting" (SCTP association coming up
			// right after the handshake) would silently swallow the bye, and
			// the peer would fall back to redialing us. Wait it out — bounded,
			// and a no-op in the normal case where the channel is long open.
			await this.waitUntil(() => session.canSendBye, BYE_OPEN_TIMEOUT_MS);
			// A concurrent `swapSession` (e.g. an incoming offer racing our
			// teardown, or a retry's `close-active-session` + `connect`) could
			// have replaced `this.session` while we were waiting. Bail out so
			// we do not send a bye on a session the peer no longer shares, or
			// tear down a session that belongs to someone else's call.
			if (this.session !== session) return;
			session.sendBye(reason === "local-exit" ? "exit" : "disconnect");
			// `sendBye` only queues bytes; `pc.close()` right after would
			// discard them.
			await this.waitUntil(() => session.bufferedAmount === 0, BYE_FLUSH_TIMEOUT_MS);
			if (this.session !== session) return;
		}
		this.closeSession(reason);
		if (stopSignaling) {
			// Fire-and-forget: `server.close()` only invokes its callback
			// once every open connection has gone away, and a peer holding
			// a keep-alive socket can stall that indefinitely. The `/exit`
			// path awaits this method before Ink's `exit()`, so awaiting
			// would hang the whole shutdown behind a remote socket.
			this.signaling.stop().catch(() => {});
		}
	}

	/**
	 * Poll `condition` until it holds or `timeoutMs` elapses. Never rejects: a
	 * missed deadline degrades the bye to best-effort, it does not block the
	 * close the user asked for.
	 */
	private async waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
		const ticks = Math.ceil(timeoutMs / BYE_FLUSH_POLL_MS);
		for (let tick = 0; tick < ticks; tick++) {
			if (condition()) return;
			await new Promise<void>((resolve) => setTimeout(resolve, BYE_FLUSH_POLL_MS));
		}
		if (!condition()) {
			getLogger().warn({ timeoutMs }, "bye deadline missed — closing anyway");
		}
	}

	/**
	 * Release the dead session's resources (pc + transport + heartbeat)
	 * and forget the reference so the next {@link connect} takes a clean
	 * `swapSession` path. For the network-driven reconnect path: the app
	 * has already received the terminal state via {@link onStateChange},
	 * and a fresh handshake will replace the session via `connect` →
	 * `swapSession`. Without this call, the dead session's open transport
	 * + heartbeat keep werift's UDP/STUN resources alive long enough that
	 * the new pc's ICE gather stalls permanently in "checking" — the
	 * user's reported "have to restart both sides" symptom.
	 *
	 * The dead session's `terminated` flag already suppressed its terminal
	 * event, so closing it again here emits nothing.
	 */
	closeActiveSession(): void {
		this.session?.close();
		this.session = undefined;
	}

	/**
	 * Close the active session with an explicit reason and forget it. The
	 * forwarders stay attached so the terminal event reaches the app.
	 */
	private closeSession(reason: "local-exit" | "local-disconnect"): void {
		this.session?.close(reason);
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

	/**
	 * Test-only escape hatch: close just the active data channel,
	 * simulating a failure that kills the channel while the pc stays up.
	 */
	_forceCloseActiveChannel(): void {
		this.session?._forceCloseDataChannel();
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
					try {
						listener(message);
					} catch (err) {
						getLogger().error({ err: errorText(err) }, "message listener threw");
					}
				}
			}),
			newSession.onFileChunk((chunk) => {
				for (const listener of this.chunkListeners) {
					try {
						listener(chunk);
					} catch (err) {
						getLogger().error({ err: errorText(err) }, "file-chunk listener threw");
					}
				}
			}),
			newSession.onStateChange((event) => {
				for (const listener of this.stateListeners) {
					try {
						listener(event);
					} catch (err) {
						getLogger().error({ err: errorText(err) }, "state listener threw");
					}
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

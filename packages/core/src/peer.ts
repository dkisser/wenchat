import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { FileChunkFramePayload, Message, MessageAckMessage } from "@wenchat/protocol";
import { encode as encodeMessage } from "@wenchat/protocol";
import type { CloseReason, ConnectionEvent } from "./connectionState";
import type { SendFileOptions, SendFileResult } from "./fileTransfer";
import { getLogger, getWorkspaceRoot } from "./logger";
import { MessageAckScheduler } from "./messageAck";
import { OutboxStore } from "./outbox";
import { ReceiveWindow } from "./receiveWindow";
import { Session } from "./session";
import { type IceCandidatePayload, type SdpPayload, SignalingServer } from "./signaling";

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

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
 *
 * PR-3 — Stage 1 application-layer reliability. The peer additionally
 * owns one `OutboxStore` + `MessageAckScheduler` for the active remote
 * peer. The pair is created lazily on the first `connect()` /
 * `acceptOffer()`, persists `seq` across reconnects (ADR 0003 Q10), and
 * is reused across `swapSession` calls — only the live transport moves.
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

	// PR-3 — per-peer reliability state. Lazily constructed on the
	// first connect / acceptOffer so that a PeerConnection that never
	// opens a session (e.g. closed before any peer shows up) doesn't
	// burn an outbox file on disk.
	private outbox?: OutboxStore;
	private messageAckScheduler?: MessageAckScheduler;
	// Set once the scheduler's `initFromOutbox` has loaded the head.
	// `send()` refuses to operate until then so we never assign a seq
	// without having first checked the persisted high-water mark.
	private schedulerReady = false;
	// The peerId the scheduler was built for. A reconnect to a
	// different host:port is "the same peer" by the outbox file
	// convention; this field exists so the tests can confirm
	// continuity assertions on the same PeerConnection object.
	private schedulerPeerId?: string;

	private messageListeners: Set<(message: Message) => void> = new Set();
	private chunkListeners: Set<(chunk: FileChunkFramePayload) => void> = new Set();
	private stateListeners: Set<(event: ConnectionEvent) => void> = new Set();
	private incomingListeners: Set<(info: IncomingOfferInfo) => void> = new Set();
	private outboxAbandonedListeners: Set<(seq: number) => void> = new Set();
	private outboxEmptyListeners: Set<() => void> = new Set();

	/**
	 * Most recent teardown intent set by {@link closeGracefully},
	 * {@link close}, or {@link disconnect}. A late `connect()` that
	 * resolves stale (see {@link closeStaleDialSession}) reads this so
	 * the resulting close carries the user's reason — without it, the
	 * default `"network"` would have the state machine retry a peer the
	 * user already /disconnected from, surfacing as a duplicate
	 * "Failed to connect to X" alongside the disconnect notice.
	 *
	 * Set before any close-path can yield, so the value is observable to
	 * `closeStaleDialSession` even when the close is racing an in-flight
	 * `connect()` (the user typed /disconnect mid-dial). Held across
	 * later closes — successive calls overwrite with the latest intent.
	 */
	private closeIntent: CloseReason | null = null;

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
		// PR-2 review edge #5: clean up stale compaction temp files left
		// behind by a crashed `OutboxStore.compact()` (the rename target
		// is in place, but a half-written temp file from a previous
		// process lingers). Best-effort; missing dir / un-deletable files
		// are not fatal.
		await cleanStaleCompactionFiles(join(getWorkspaceRoot(), "outbox"));
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

			// PR-3 — ensure the per-peer outbox + scheduler are wired up
			// before the new session can deliver anything. The peerId is
			// derived from the offer payload's signaling endpoint.
			const peerId = peerIdForEndpoint(offer.signalingHost, offer.signalingPort);
			await this.ensureMessageAckScheduler(peerId);

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

		// Authoritative teardown-intent channel (TCP). Unlike the in-band
		// DataChannel `bye`, this cannot race the sender's pc teardown: the
		// sender awaits the HTTP response before calling `pc.close()`, so by
		// the time any SCTP ABORT is on the wire the reason is already
		// recorded here. Forward to the live session — a bye for a session
		// we already replaced is stale and the `terminated` guard in the
		// (possibly already-closed) current session absorbs double delivery.
		this.signaling.onBye((bye) => {
			const session = this.session;
			const endpoint = session?.remoteEndpoint;
			if (!session || !endpoint) return;
			// Identity check: the bye must be from the peer our LIVE session
			// is talking to. A late bye from a previous peer (their teardown
			// raced our new handshake) would otherwise tear down the wrong
			// session — the payload carries no channel identity of its own.
			if (endpoint.host !== bye.fromHost || endpoint.port !== bye.fromPort) {
				getLogger().warn({ bye }, "ignoring bye from an endpoint that is not the live session");
				return;
			}
			session.receiveRemoteBye(bye.reason);
		});
	}

	getSignalingPort(): number {
		return this.signaling.getPort();
	}

	async connect(peerHost: string, peerPort: number): Promise<Session> {
		// PR-3 — ensure the per-peer outbox + scheduler exist before we
		// open the session, so the very first send on a fresh process can
		// pick up the persisted `seq` from the outbox header (Q10).
		const peerId = peerIdForEndpoint(peerHost, peerPort);
		await this.ensureMessageAckScheduler(peerId);

		const newSession = await Session.initiate({
			signaling: this.signaling,
			localHost: this.localSignalingHost,
			localPort: this.signaling.getPort(),
			remoteHost: peerHost,
			remotePort: peerPort,
		});
		this.swapSession(newSession);
		// The returned session lets the caller close ITS OWN session if it
		// turns out to be a stale resolve (a later `connect()` already
		// swapped it out). Without this, `closeActiveSession()` operated on
		// `this.session` (whatever is current) — in a race with an incoming
		// offer, the stale check would tear down the user's incoming peer.
		return newSession;
	}

	send(message: Message): void {
		if (!this.session) {
			throw new Error("Data channel not ready");
		}
		// PR-3 — assign a per-peer monotonic seq, persist the encoded
		// payload to the outbox, and arm the per-message retransmit timer.
		// All three happen before the wire send so the sender's view of
		// the world is consistent: by the time the byte reaches the
		// transport, the outbox already has the row and a recovery
		// path exists if the ACK never lands.
		const scheduler = this.messageAckScheduler;
		if (!scheduler || !this.outbox || !this.schedulerReady) {
			throw new Error("Data channel not ready");
		}
		const seq = scheduler.allocateSeq();
		const tagged: Message = { ...message, seq };
		const encodedBytes = encodeMessage(tagged);
		const encodedString = new TextDecoder().decode(encodedBytes);
		// Persist + register retransmit BEFORE the wire send. A crash
		// between the wire send and this point would lose the message;
		// doing it before means the worst case is "we sent but no row
		// landed" — a single lost message is recoverable (the peer will
		// surface a missing-message complaint), whereas "row landed but
		// no timer fires" is a silent loss.
		void this.outbox.append(seq, encodedString).catch((err: unknown) => {
			getLogger().error(
				{ err: errorText(err), seq },
				"outbox.append failed — sender's recovery view is incomplete",
			);
		});
		scheduler.scheduleRetransmit(seq, encodedString);
		this.session.send(tagged);
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
		this.closeIntent = "local-exit";
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
		this.closeIntent = "local-disconnect";
		// PR-3 — ADR 0003 Q3: emit a final ACK before tearing down so
		// the peer's view of our progress is current. Best-effort: if
		// the channel is already dead, the sendAck callback silently
		// drops it.
		this.messageAckScheduler?.closeSession();
		this.closeSession("local-disconnect");
	}

	/**
	 * Deliver teardown intent to the peer over the signaling channel
	 * (TCP), wait for it to be recorded there, THEN close. This is what
	 * makes the far end say "they left" instead of burning a 28-second
	 * redial window — and it is reliable by construction, unlike the
	 * in-band DataChannel `bye` it replaces: an in-band goodbye races the
	 * SCTP ABORT that `pc.close()` queues behind it, and three generations
	 * of sender-side flush workarounds (waiting on `bufferedAmount`, on
	 * werift's outboundQueue, forcing `sctp.transmit()`) could never close
	 * that race because the guarantee lives on the receiver. Awaiting an
	 * HTTP 200 IS the guarantee: the peer's `/bye` handler has already run
	 * before any teardown byte leaves this process.
	 *
	 * `stopSignaling` mirrors the {@link close} vs {@link disconnect} split.
	 */
	async closeGracefully(
		reason: "local-exit" | "local-disconnect",
		stopSignaling = reason === "local-exit",
	): Promise<void> {
		// Set the intent BEFORE any await so a `connect()` that resolves
		// stale during the HTTP bye reads the right reason out of
		// `closeStaleDialSession`. See `closeIntent`'s note.
		this.closeIntent = reason;
		const session = this.session;
		if (session) {
			const byeReason = reason === "local-exit" ? ("exit" as const) : ("disconnect" as const);
			// Compat shim for pre-HTTP-bye builds: they only understand the
			// in-band message. Best-effort, no flush — see `Session.sendBye`.
			session.sendBye(byeReason);
			const endpoint = session.remoteEndpoint;
			if (endpoint) {
				try {
					await this.signaling.sendBye(endpoint.host, endpoint.port, byeReason, {
						host: this.localSignalingHost,
						port: this.signaling.getPort(),
					});
				} catch (err) {
					// ECONNREFUSED → the peer's process is already gone, there is
					// nobody to inform. Timeout/404 (old build) → degrade to the
					// in-band best-effort behaviour. Either way the local close
					// the user asked for must proceed.
					getLogger().warn({ err: errorText(err), reason }, "http bye not delivered");
				}
			}
			// A concurrent `swapSession` (an incoming offer racing our
			// teardown) could have replaced `this.session` while the HTTP
			// round trip was in flight. Bail out rather than tear down a
			// session that belongs to someone else's call.
			if (this.session !== session) return;
		}
		// PR-3 — emit a final ACK so the peer has our latest progress
		// recorded before the channel goes away. The peer will then
		// stop retransmitting whatever we successfully received.
		this.messageAckScheduler?.closeSession();
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
	 *
	 * **Identity guarantee:** if the caller wants to close a SPECIFIC
	 * session (the one this method's caller just created, say) rather than
	 * whatever happens to be current on `this.session`, use {@link closeSession}.
	 * This method is intentionally identity-less because every existing
	 * caller (the retry-timer path in the CLI) belongs to the redundant
	 * "kill the previous round's session" flow and is happy with "current".
	 */
	closeActiveSession(): void {
		this.session?.close();
		this.session = undefined;
	}

	/**
	 * Close a SPECIFIC session — the one the caller created or holds a
	 * reference to — regardless of whether `this.session` still points to
	 * it. The session's `terminated` flag makes a second close a no-op,
	 * so this is safe even if the session has already been torn down
	 * (e.g. by `swapSession` during a race).
	 *
	 * If the session is still `this.session`, the active session is closed
	 * AND the reference is forgotten. This is what callers reaching for
	 * "close my own session" want when their late `connect()` resolves
	 * under a generation that has since moved — closing THIS specific
	 * session lets the swap-installed peer stay alive instead of being
	 * torn down by `closeActiveSession`, which would target the now-current
	 * session.
	 */
	closeStaleDialSession(session: Session): void {
		// Honor any teardown intent observed since the stale dial started.
		// Without this, a `/disconnect` or `/exit` issued during a connect
		// would race: this method would close the new session with
		// `reason = "network"` (the default), and the state machine would
		// interpret that as retryable — "Failed to connect to X" right
		// alongside the user's actual disconnect notice.
		const reason = this.closeIntent ?? "network";
		if (this.session === session) {
			session.close(reason);
			this.session = undefined;
			return;
		}
		// Already detached by `swapSession` (or never installed here). The
		// session's `terminated` flag suppresses a second close event.
		session.close(reason);
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
	 * PR-3 — observe the current sender-side outbox depth (unacked +
	 * pending retransmits). Used by tests to assert drain-to-zero after a
	 * graceful close, and by future CLI progress reporting. Returns 0
	 * when no peer / outbox exists yet.
	 */
	outboxSize(): number {
		return this.messageAckScheduler ? this.messageAckScheduler.pendingCount() : 0;
	}

	/**
	 * Fires when a sender-side message exceeds its retry budget
	 * (ADR 0003 Q4). Subscribed by the CLI in PR-6 to surface a system
	 * message; no other listener fires today.
	 */
	onOutboxAbandoned(callback: (seq: number) => void): () => void {
		this.outboxAbandonedListeners.add(callback);
		return () => {
			this.outboxAbandonedListeners.delete(callback);
		};
	}

	/**
	 * Fires exactly once per outbox-empty transition (sender side).
	 * Useful for CLI status indicators that flip "delivering" → "idle".
	 */
	onOutboxEmpty(callback: () => void): () => void {
		this.outboxEmptyListeners.add(callback);
		return () => {
			this.outboxEmptyListeners.delete(callback);
		};
	}

	/**
	 * PR-3 — ensure the per-peer outbox + scheduler exist for `peerId`.
	 * Lazily constructed on first connect / acceptOffer so a
	 * PeerConnection that never opens a session doesn't burn an outbox
	 * file on disk.
	 *
	 * The scheduler is sticky to the first peerId; subsequent
	 * connect/acceptOffer calls reuse the same instance regardless of
	 * endpoint. This is what makes `swapSession` continuity hold: the
	 * sender-side seq counter and retransmit timers outlive any one
	 * transport session.
	 */
	private async ensureMessageAckScheduler(peerId: string): Promise<void> {
		if (this.messageAckScheduler && this.schedulerPeerId === peerId) {
			return;
		}
		// A different peerId is unexpected under the current 1-to-1 model,
		// but if it happens we close the previous scheduler cleanly so
		// its timers don't leak.
		if (this.messageAckScheduler) {
			this.messageAckScheduler.closeSession();
		}
		const outboxPath = join(getWorkspaceRoot(), "outbox", `${peerId}.jsonl`);
		this.outbox = new OutboxStore(outboxPath);
		// PR-4 — construct the receive window explicitly here (default
		// cap = 256, ADR 0003 Q7) and hand it to the scheduler so its
		// lifetime matches the scheduler's: same `PeerConnection`, same
		// peerId, same `swapSession` continuity. Tests can pass a smaller
		// cap via `MessageAckSchedulerOptions.dedupWindowSize` instead.
		const receiveWindow = new ReceiveWindow();
		this.messageAckScheduler = new MessageAckScheduler({
			outbox: this.outbox,
			receiveWindow,
			sendAck: (ack) => this.dispatchOutbound(ack),
			sendMessage: (msg) => this.dispatchOutbound(msg),
			onOutboxAbandoned: (seq) => this.notifyOutboxAbandoned(seq),
			onOutboxEmpty: () => this.notifyOutboxEmpty(),
		});
		this.schedulerPeerId = peerId;
		await this.messageAckScheduler.initFromOutbox();
		this.schedulerReady = true;
	}

	/**
	 * PR-3 — push an outbound frame through the current session. Used by
	 * the scheduler's `sendAck` and `sendMessage` callbacks. A no-op
	 * when no session is active (the transport will resync on the next
	 * session); the retransmit timer keeps firing so a queued message
	 * still gets a chance to land.
	 */
	private dispatchOutbound(message: Message): void {
		if (!this.session) {
			getLogger().debug({ type: message.type }, "scheduler outbound: no session, dropping");
			return;
		}
		this.session.send(message);
	}

	private notifyOutboxAbandoned(seq: number): void {
		getLogger().error({ seq }, "outbox abandoned");
		for (const listener of this.outboxAbandonedListeners) {
			try {
				listener(seq);
			} catch (err) {
				getLogger().error({ err: errorText(err), seq }, "outbox-abandoned listener threw");
			}
		}
	}

	private notifyOutboxEmpty(): void {
		for (const listener of this.outboxEmptyListeners) {
			try {
				listener();
			} catch (err) {
				getLogger().error({ err: errorText(err) }, "outbox-empty listener threw");
			}
		}
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
				// PR-3 — `message-ack` is control plane; the scheduler
				// owns it, app code must never see it (it has no id/
				// timestamp semantics a chat log would know what to do
				// with).
				if (message.type === "message-ack") {
					const ackMsg: MessageAckMessage = message;
					if (this.messageAckScheduler) {
						void this.messageAckScheduler.noteAck(ackMsg.payload.ack);
					}
					return;
				}
				// PR-3 — basic dedup (PR-4 ReceiveWindow stand-in). For
				// any seq-bearing message, drop the second sighting. The
				// scheduler's `noteInbound` is the gate: it returns
				// `"duplicate"` for a recently-seen seq (which it then
				// drops without forwarding), `"new"` for everything else.
				if (message.seq !== null && message.seq !== undefined) {
					const result = this.messageAckScheduler?.noteInbound(message.seq);
					if (result === "duplicate") {
						getLogger().debug(
							{ seq: message.seq, type: message.type },
							"dropping duplicate inbound",
						);
						return;
					}
				}
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

/**
 * Derive a stable peerId from a signaling endpoint. The endpoint is
 * `host:port` — for our LAN-only deployment host is a concrete IPv4 and
 * port is whatever the OS gave us. Across reconnects the host is stable;
 * the port can change when the peer's process restarts. PR-3 accepts the
 * imperfection: a different port = a different outbox = a fresh outbox
 * (acceptable — the previous conversation is genuinely lost).
 */
function peerIdForEndpoint(host: string | undefined, port: number | undefined): string {
	const safeHost = host && host.length > 0 ? host : "unknown";
	const safePort = typeof port === "number" && port > 0 ? String(port) : "0";
	return `${safeHost}_${safePort}`;
}

/**
 * PR-2 review edge #5: clean up stale compaction temp files left behind
 * by a crashed `OutboxStore.compact()`. The compactor writes a temp
 * sibling (`<filePath>.compact-<pid>-<ts>`) and atomically renames it
 * over the live file. A crash between the write and the rename leaves
 * the temp behind; a future `OutboxStore` opening the live file would
 * ignore it, but the bytes stay on disk forever.
 *
 * Best-effort: a missing dir, an unreadable dir, or an undeletable file
 * is logged at debug and skipped — none of these should prevent startup.
 */
async function cleanStaleCompactionFiles(outboxDir: string): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(outboxDir);
	} catch {
		// Directory doesn't exist yet — nothing to clean.
		return;
	}
	for (const entry of entries) {
		if (!entry.includes(".compact-")) continue;
		try {
			await unlink(join(outboxDir, entry));
			getLogger().debug({ file: entry }, "cleaned stale outbox compaction temp");
		} catch {
			// Leave the file; next launch will retry.
		}
	}
}

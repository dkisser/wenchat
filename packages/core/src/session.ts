import type { FileChunkFramePayload, Message } from "@wenchat/protocol";
import { createBye } from "@wenchat/protocol";
import type { ByeReason } from "@wenchat/protocol";
import { type RTCDataChannel, RTCIceCandidate, RTCPeerConnection } from "werift";
import {
	type CloseReason,
	type ConnectionEvent,
	normalizeConnectionState,
	remoteReasonFor,
} from "./connectionState";
import {
	type SendFileOptions,
	type SendFileResult,
	sendFile as streamFileToPeer,
} from "./fileTransfer";
import { HeartbeatScheduler } from "./heartbeat";
import { getLogger } from "./logger";
import type { IceCandidatePayload, SdpPayload, SignalingServer } from "./signaling";
import { DataTransport } from "./transport";

const DATA_CHANNEL_LABEL = "wenchat";

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export type InitiateOptions = {
	signaling: SignalingServer;
	localHost: string;
	localPort: number;
	remoteHost: string;
	remotePort: number;
};

export type AcceptOptions = {
	signaling: SignalingServer;
	localHost: string;
	localPort: number;
	offer: SdpPayload;
};

/**
 * One WebRTC handshake, bundled.
 *
 * Encapsulates everything whose lifetime is one offer/answer exchange:
 * the `RTCPeerConnection`, the `DataTransport` over the resulting
 * `DataChannel`, the heartbeat, the pending-ICE queue, and the remote
 * endpoint. A new `Session` is constructed for every `connect()` /
 * `acceptOffer()` call on `PeerConnection`.
 *
 * Why this is its own object: a werift `RTCPeerConnection` allocates
 * its SCTP transport exactly once per instance (the upstream check is
 * `if (!this.sctpTransport)`). After a previous session goes terminal
 * — even via "natural" `disconnected` — that SCTP binding cannot be
 * made usable again on the same pc. The only way to recover after a
 * disconnect is a brand-new pc, which forces a brand-new `Session`.
 */
export class Session {
	private pc!: RTCPeerConnection;
	private transport?: DataTransport;
	private heartbeat!: HeartbeatScheduler;
	private pendingCandidates: IceCandidatePayload[] = [];
	private remoteHost?: string;
	private remotePort?: number;
	// Once a terminal WebRTC state has been observed (or our heartbeat
	// fired), we suppress subsequent terminal emissions so listeners see
	// at most one `closed` per session.
	private terminated = false;
	// Set by `close(reason)` or by an inbound `bye` BEFORE the pc teardown
	// races back through `onconnectionstatechange`. Whoever gets to
	// `notifyStateChange` first reads it; absent, a terminal state is by
	// definition a transport failure and reads as "network".
	private pendingCloseReason?: CloseReason;

	private readonly signaling: SignalingServer;

	private messageListeners: Set<(message: Message) => void> = new Set();
	private chunkListeners: Set<(chunk: FileChunkFramePayload) => void> = new Set();
	private stateListeners: Set<(event: ConnectionEvent) => void> = new Set();

	// The SDP answer produced by `accept()`. Read once by
	// `PeerConnection` after constructing the session, so the signaling
	// callback can write it back in the HTTP response. Undefined on
	// initiator sessions.
	private _answerSdp?: string;

	private constructor(signaling: SignalingServer) {
		this.signaling = signaling;
	}

	/**
	 * Construct a Session for the initiator side: create a data
	 * channel locally, generate the offer, POST it through the remote
	 * peer's signaling server, and apply the returned answer.
	 */
	static async initiate(opts: InitiateOptions): Promise<Session> {
		const session = new Session(opts.signaling);
		session.remoteHost = opts.remoteHost;
		session.remotePort = opts.remotePort;

		session.installPeerConnection();

		try {
			const channel = session.pc.createDataChannel(DATA_CHANNEL_LABEL);
			session.attachTransport(channel as unknown as RTCDataChannel);

			const offer = await session.pc.createOffer();
			await session.pc.setLocalDescription(offer);

			const answer = await session.signaling.sendOffer(opts.remoteHost, opts.remotePort, {
				type: "offer",
				sdp: offer.sdp,
				signalingHost: opts.localHost,
				signalingPort: opts.localPort,
			});

			await session.pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
			await session.flushPendingCandidates();

			return session;
		} catch (err) {
			// The handshake failed AFTER the pc was created — without teardown
			// the half-open pc (UDP socket, ICE gathering) leaks for the rest
			// of the process on every failed `/connect`.
			session.abortAfterFailedHandshake();
			throw err;
		}
	}

	/**
	 * Construct a Session for the acceptor side: apply the incoming
	 * offer, create the answer SDP, and expose it via `answerSdp` for
	 * the signaling callback to write back.
	 */
	static async accept(opts: AcceptOptions): Promise<Session> {
		const session = new Session(opts.signaling);

		if (opts.offer.signalingHost && opts.offer.signalingPort) {
			session.remoteHost = opts.offer.signalingHost;
			session.remotePort = opts.offer.signalingPort;
		}

		session.installPeerConnection();

		try {
			await session.pc.setRemoteDescription({ type: "offer", sdp: opts.offer.sdp });
			const answer = await session.pc.createAnswer();
			await session.pc.setLocalDescription(answer);

			session._answerSdp = answer.sdp;
			await session.flushPendingCandidates();

			return session;
		} catch (err) {
			// Same leak guard as initiate(): a malformed offer or ICE error
			// must not strand the freshly created pc.
			session.abortAfterFailedHandshake();
			throw err;
		}
	}

	get answerSdp(): string | undefined {
		return this._answerSdp;
	}

	send(message: Message): void {
		if (!this.transport) {
			throw new Error("Data channel not ready");
		}
		this.transport.send(message);
	}

	/**
	 * Stream a file to the connected peer (chunked, backpressured,
	 * sha256-verified). See `fileTransfer.ts` for the wire flow. Throws
	 * "Data channel not ready" when no transport is attached.
	 */
	async sendFile(path: string, options?: SendFileOptions): Promise<SendFileResult> {
		if (!this.transport) {
			throw new Error("Data channel not ready");
		}
		return streamFileToPeer(this.transport, path, options);
	}

	onMessage(callback: (message: Message) => void): () => void {
		this.messageListeners.add(callback);
		return () => {
			this.messageListeners.delete(callback);
		};
	}

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
	 * Best-effort IN-BAND compat shim: peers from before the HTTP `/bye`
	 * endpoint only understand a DataChannel `bye`. It races teardown and
	 * may be dropped — the authoritative intent signal is the HTTP bye
	 * (`SignalingServer.sendBye`), which `PeerConnection.closeGracefully`
	 * awaits before closing the pc. Never throws.
	 */
	sendBye(reason: ByeReason): void {
		if (!this.transport?.isOpen) return;
		try {
			this.transport.send(createBye(reason));
		} catch (err) {
			getLogger().warn({ err: errorText(err), reason }, "bye not sent");
		}
	}

	/**
	 * The peer's signaling endpoint, learned during the handshake (from the
	 * offer payload on the acceptor side, from the dial target on the
	 * initiator side). The graceful-close path needs it to deliver the HTTP
	 * bye; null only for offers from protocol versions that predate the
	 * endpoint fields.
	 */
	get remoteEndpoint(): { readonly host: string; readonly port: number } | null {
		if (!this.remoteHost || !this.remotePort) return null;
		return { host: this.remoteHost, port: this.remotePort };
	}

	/**
	 * Tear this session down locally.
	 *
	 * `reason` records *why*, so the terminal event this triggers carries the
	 * intent instead of looking like a network failure. It defaults to
	 * `"network"` for callers that are cleaning up after a transport that has
	 * already died.
	 */
	close(reason: CloseReason = "network"): void {
		this.pendingCloseReason = reason;
		this.stopHeartbeat();
		this.transport?.close();
		this.pc.close();
	}

	/**
	 * Test-only escape hatch: forcibly close the underlying pc to
	 * simulate abrupt process death without the graceful session
	 * teardown.
	 */
	_forceClosePc(): void {
		this.pc.close();
	}

	/**
	 * Test-only escape hatch: close just the data channel, simulating a
	 * transfer failure that kills the channel while the pc itself stays
	 * up — the "phantom online" scenario.
	 */
	_forceCloseDataChannel(): void {
		this.transport?.close();
	}

	/**
	 * Apply an inbound ICE candidate. If the remote description has
	 * not been set yet (which can happen when candidates and offer
	 * arrive at the signaling server out of order — Node will interleave
	 * their handlers), the candidate is queued and drained after the
	 * answer SDP is applied.
	 */
	async addIceCandidate(candidate: IceCandidatePayload): Promise<void> {
		if (!this.pc.remoteDescription) {
			this.pendingCandidates = [...this.pendingCandidates, candidate];
			return;
		}
		await this.pc.addIceCandidate(
			new RTCIceCandidate({
				candidate: candidate.candidate,
				sdpMid: candidate.sdpMid,
				sdpMLineIndex: candidate.sdpMLineIndex,
			}),
		);
	}

	private installPeerConnection(): void {
		this.pc = new RTCPeerConnection({
			iceServers: [],
		});

		this.pc.onicecandidate = (event) => {
			if (event.candidate && this.remoteHost && this.remotePort) {
				this.signaling
					.sendCandidate(this.remoteHost, this.remotePort, {
						candidate: event.candidate.candidate,
						sdpMid: event.candidate.sdpMid,
						sdpMLineIndex: event.candidate.sdpMLineIndex,
					})
					.catch(() => {});
			}
		};

		this.pc.ondatachannel = (event) => {
			this.attachTransport(event.channel as unknown as RTCDataChannel);
		};

		this.pc.onconnectionstatechange = () => {
			this.notifyStateChange(this.pc.connectionState);
		};

		this.heartbeat = new HeartbeatScheduler({
			send: (msg) => this.send(msg),
			canSend: () => this.transport !== undefined,
			onTimeout: () => this.failByHeartbeat(),
		});
	}

	private attachTransport(channel: RTCDataChannel): void {
		this.transport = new DataTransport(channel);
		this.transport.onMessage((message) => {
			// Heartbeat traffic stays in the scheduler; user-facing
			// listeners only see application messages.
			if (message.type === "ping" || message.type === "pong") {
				this.heartbeat?.handleIncoming(message);
				return;
			}
			// A `bye` is control plane, not chat: it must never reach the
			// message listeners or it would land in the chat log.
			if (message.type === "bye") {
				this.receiveRemoteBye(message.payload.reason);
				return;
			}
			for (const listener of this.messageListeners) {
				try {
					listener(message);
				} catch (err) {
					getLogger().error({ err: errorText(err) }, "message listener threw");
				}
			}
		});
		this.transport.onFileChunk((chunk) => {
			for (const listener of this.chunkListeners) {
				try {
					listener(chunk);
				} catch (err) {
					getLogger().error({ err: errorText(err) }, "file-chunk listener threw");
				}
			}
		});
		// A channel that dies WITHOUT the pc following (e.g. a failed file
		// transfer tearing down only the stream) used to leave both sides
		// "online" forever: the heartbeat kept running on the dead channel's
		// sibling state and the UI guard then refused any reconnect. Propagate
		// the close as a terminal state — the `terminated` guard dedupes this
		// against pc-level closes and heartbeat timeouts, and a local
		// disconnect never reaches listeners because PeerConnection detaches
		// its forwarders before closing the session.
		this.transport.onClose(() => {
			getLogger().warn("data channel closed");
			this.notifyStateChange("closed");
		});
	}

	private async flushPendingCandidates(): Promise<void> {
		for (const candidate of this.pendingCandidates) {
			await this.addIceCandidate(candidate);
		}
		this.pendingCandidates = [];
	}

	/**
	 * Best-effort teardown after a failed handshake. Never throws — the
	 * original handshake error is the one the caller needs.
	 */
	private abortAfterFailedHandshake(): void {
		try {
			this.close();
		} catch {
			// close() on a half-initialized pc may itself throw; the
			// handshake error being rethrown takes precedence.
		}
	}

	private notifyStateListeners(event: ConnectionEvent): void {
		for (const listener of this.stateListeners) {
			try {
				listener(event);
			} catch (err) {
				getLogger().error({ err: errorText(err) }, "state listener threw");
			}
		}
	}

	/**
	 * Normalise a raw werift connection state into a `ConnectionEvent` and
	 * fan it out. Terminal states are deduped by `terminated` so listeners
	 * see exactly one `closed` per session, and the reason comes from
	 * `pendingCloseReason` when a local intent (or an inbound `bye`) set it.
	 */
	private notifyStateChange(rawState: string): void {
		const state = normalizeConnectionState(rawState);
		if (state === null) {
			// "new" — pre-handshake noise, carries nothing for the app.
			return;
		}
		if (state === "connected") {
			this.heartbeat?.start();
		}
		if (state === "closed") {
			if (this.terminated) {
				// Already terminated (e.g. heartbeat path closed the pc).
				// Suppress the duplicate so listeners see one terminal
				// event per session.
				this.stopHeartbeat();
				return;
			}
			this.terminated = true;
			this.stopHeartbeat();
			// werift does NOT mark data channels closed when the pc dies —
			// without this a sender blocked in `waitForDrain` would hang
			// forever on a channel whose readyState never changes.
			this.transport?.close();
			const reason = this.pendingCloseReason ?? "network";
			getLogger().info({ rawState, reason }, "connection terminated");
			this.notifyStateListeners({ state: "closed", reason });
			return;
		}
		getLogger().info({ rawState }, "connection state");
		this.notifyStateListeners({ state });
	}

	private stopHeartbeat(): void {
		this.heartbeat?.stop();
	}

	/**
	 * The peer told us it is leaving on purpose — via the HTTP `/bye`
	 * endpoint (authoritative, awaited by the sender before it tears down)
	 * or, from an older build, an in-band DataChannel `bye` (best-effort).
	 * Tear down immediately with the remote reason rather than waiting for
	 * its `pc.close()` to propagate: that path is asynchronous and
	 * unguaranteed, and in the gap our own heartbeat watchdog could fire
	 * first and relabel the close as `heartbeat-timeout` — which reads as
	 * retryable and puts us right back in the redial loop this whole
	 * mechanism exists to avoid.
	 */
	receiveRemoteBye(reason: ByeReason): void {
		if (this.terminated) return;
		this.terminated = true;
		this.stopHeartbeat();
		const closeReason = remoteReasonFor(reason);
		getLogger().info({ reason }, "peer said bye");
		// Mirror `failByHeartbeat`: close the channel explicitly so an
		// in-flight `sendFile` observes the death, then the pc.
		this.transport?.close();
		try {
			this.pc.close();
		} catch {
			// pc.close() is idempotent — ignore double-close.
		}
		this.notifyStateListeners({ state: "closed", reason: closeReason });
	}

	private failByHeartbeat(): void {
		if (this.terminated) return;
		this.terminated = true;
		this.stopHeartbeat();
		getLogger().warn("heartbeat timed out — peer is unreachable");
		// Close the channel explicitly: pc.close() alone leaves the
		// DataChannel "open" in werift, and any in-flight `sendFile`
		// would never observe the death.
		this.transport?.close();
		try {
			this.pc.close();
		} catch {
			// pc.close() is idempotent — ignore double-close.
		}
		this.notifyStateListeners({ state: "closed", reason: "heartbeat-timeout" });
	}
}

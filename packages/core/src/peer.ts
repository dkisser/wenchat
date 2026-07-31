import type { Message } from "@wenchat/protocol";
import { type RTCDataChannel, RTCIceCandidate, RTCPeerConnection } from "werift";
import { HeartbeatScheduler } from "./heartbeat";
import { type IceCandidatePayload, type SdpPayload, SignalingServer } from "./signaling";
import { DataTransport } from "./transport";

const DATA_CHANNEL_LABEL = "wenchat";

export class PeerConnection {
	private pc!: RTCPeerConnection;
	private transport?: DataTransport;
	private signaling: SignalingServer;
	private messageListeners: Set<(message: Message) => void> = new Set();
	private stateListeners: Set<(state: string) => void> = new Set();
	private pendingCandidates: IceCandidatePayload[] = [];
	private remoteHost?: string;
	private remotePort?: number;
	private heartbeat?: HeartbeatScheduler;
	// Once a terminal WebRTC state has been observed (or our heartbeat fired),
	// we suppress subsequent terminal emissions so listeners see at most one
	// `disconnected`/`closed`/`failed` per connection attempt.
	private terminated = false;

	private localSignalingHost = "127.0.0.1";

	constructor() {
		this.signaling = new SignalingServer();
		this.recreatePc();
	}

	async startListening(signalingPort: number, signalingHost = "127.0.0.1"): Promise<void> {
		this.localSignalingHost = signalingHost;
		await this.signaling.start(signalingPort, signalingHost);
		this.signaling.onOffer(async (offer) => {
			return this.acceptOffer(offer);
		});
		this.signaling.onCandidate((candidate) => {
			this.addIceCandidate(candidate);
		});
	}

	getSignalingPort(): number {
		return this.signaling.getPort();
	}

	async connect(peerHost: string, peerPort: number): Promise<void> {
		this.remoteHost = peerHost;
		this.remotePort = peerPort;

		// If a previous connection finished (closed/failed/disconnected),
		// the existing RTCPeerConnection cannot be reused — createOffer / ICE
		// would no-op on a closed pc and the connection would hang. Rebuild
		// it so the handshake runs on a live pc.
		const terminal = new Set(["closed", "failed", "disconnected"]);
		if (terminal.has(this.pc.connectionState)) {
			this.recreatePc();
		}

		this.pendingCandidates = [];

		const channel = this.pc.createDataChannel(DATA_CHANNEL_LABEL);
		this.attachTransport(channel as unknown as RTCDataChannel);

		const offer = await this.pc.createOffer();
		await this.pc.setLocalDescription(offer);

		const answer = await this.signaling.sendOffer(peerHost, peerPort, {
			type: "offer",
			sdp: offer.sdp,
			signalingHost: this.localSignalingHost,
			signalingPort: this.signaling.getPort(),
		});

		await this.pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });

		for (const candidate of this.pendingCandidates) {
			await this.addIceCandidate(candidate);
		}
		this.pendingCandidates = [];
	}

	async acceptOffer(offer: SdpPayload): Promise<SdpPayload> {
		if (offer.signalingHost && offer.signalingPort) {
			this.remoteHost = offer.signalingHost;
			this.remotePort = offer.signalingPort;
		}

		await this.pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
		const answer = await this.pc.createAnswer();
		await this.pc.setLocalDescription(answer);

		for (const candidate of this.pendingCandidates) {
			await this.addIceCandidate(candidate);
		}
		this.pendingCandidates = [];

		return { type: "answer", sdp: answer.sdp };
	}

	send(message: Message): void {
		if (!this.transport) {
			throw new Error("Data channel not ready");
		}
		this.transport.send(message);
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
		// Local graceful close: stop the heartbeat first so its watchdog
		// doesn't fire AFTER we've already torn everything down. The natural
		// WebRTC `closed` will still propagate.
		this.stopHeartbeat();
		this.transport?.close();
		this.pc.close();
		this.signaling.stop().catch(() => {});
	}

	private recreatePc(): void {
		// Close any previous transport cleanly so the underlying
		// RTCDataChannel isn't leaked across reconnects.
		if (this.transport) {
			this.transport.close();
			this.transport = undefined;
		}
		this.stopHeartbeat();
		this.terminated = false;

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

		// A fresh heartbeat per pc — its timers are tied to this connection's
		// lifecycle, so a reconnect gets a clean slate.
		this.heartbeat = new HeartbeatScheduler({
			send: (msg) => this.send(msg),
			onTimeout: () => this.failByHeartbeat(),
		});
	}

	private attachTransport(channel: RTCDataChannel): void {
		this.transport = new DataTransport(channel);
		this.transport.onMessage((message) => {
			// Heartbeat traffic is the only thing we filter out before the
			// user-facing fan-out. DataTransport stays a dumb JSON pipe.
			if (message.type === "ping" || message.type === "pong") {
				this.heartbeat?.handleIncoming(message);
				return;
			}
			this.notifyMessage(message);
		});
	}

	private async addIceCandidate(candidate: IceCandidatePayload): Promise<void> {
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

	private notifyMessage(message: Message): void {
		for (const listener of this.messageListeners) {
			listener(message);
		}
	}

	private notifyStateChange(state: string): void {
		if (state === "connected") {
			this.heartbeat?.start();
		}
		if (state === "disconnected" || state === "closed" || state === "failed") {
			if (this.terminated) {
				// Already terminated (heartbeat path closed the pc). Suppress
				// duplicate terminal events so listeners see one offline event.
				this.stopHeartbeat();
				return;
			}
			this.terminated = true;
			this.stopHeartbeat();
		}
		for (const listener of this.stateListeners) {
			listener(state);
		}
	}

	private stopHeartbeat(): void {
		if (this.heartbeat) {
			this.heartbeat.stop();
		}
	}

	private failByHeartbeat(): void {
		if (this.terminated) return;
		this.terminated = true;
		this.stopHeartbeat();
		try {
			this.pc.close();
		} catch {
			// pc.close() is idempotent — ignore double-close.
		}
		for (const listener of this.stateListeners) {
			listener("disconnected");
		}
	}
}

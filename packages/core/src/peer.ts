import { type Message } from "@wenchat/protocol";
import {
	RTCPeerConnection,
	type RTCDataChannel,
	RTCIceCandidate,
} from "werift";
import {
	SignalingServer,
	type IceCandidatePayload,
	type SdpPayload,
} from "./signaling";
import { DataTransport } from "./transport";

const DATA_CHANNEL_LABEL = "wenchat";

export class PeerConnection {
	private pc: RTCPeerConnection;
	private transport?: DataTransport;
	private signaling: SignalingServer;
	private messageListeners: Set<(message: Message) => void> = new Set();
	private stateListeners: Set<(state: string) => void> = new Set();
	private pendingCandidates: IceCandidatePayload[] = [];
	private remoteHost?: string;
	private remotePort?: number;

	private localSignalingHost = "127.0.0.1";

	constructor() {
		this.pc = new RTCPeerConnection({
			iceServers: [],
		});
		this.signaling = new SignalingServer();

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
	}

	async startListening(signalingPort: number, signalingHost = "127.0.0.1"): Promise<void> {
		this.localSignalingHost = signalingHost;
		await this.signaling.start(signalingPort);
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
		this.transport?.close();
		this.pc.close();
		this.signaling.stop().catch(() => {});
	}

	private attachTransport(channel: RTCDataChannel): void {
		this.transport = new DataTransport(channel);
		this.transport.onMessage((message) => {
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
		for (const listener of this.stateListeners) {
			listener(state);
		}
	}
}

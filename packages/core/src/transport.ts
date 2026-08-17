import {
	type FileChunkMessage,
	type Message,
	decode,
	decodeFileChunkFrame,
	encode,
	isFileChunkFrame,
} from "@wenchat/protocol";
import type { RTCDataChannel } from "werift";
import { getLogger } from "./logger";

const DEFAULT_DRAIN_POLL_MS = 5;

export class DataTransport {
	private channel: RTCDataChannel;
	private messageListeners: Set<(message: Message) => void> = new Set();
	private closeListeners: Set<() => void> = new Set();
	// werift can surface a close twice (onclose callback AND the "close"
	// emit both fire from setReadyState) — listeners see it once.
	private closeNotified = false;

	constructor(channel: RTCDataChannel) {
		this.channel = channel;
		this.channel.onmessage = (event) => {
			const data = event.data as Buffer | Uint8Array | ArrayBuffer | string;
			try {
				if (typeof data === "string") {
					this.notifyListeners(decode(new TextEncoder().encode(data)));
					return;
				}
				const buffer = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
				if (isFileChunkFrame(buffer)) {
					this.notifyListeners(synthesizeFileChunk(buffer));
					return;
				}
				this.notifyListeners(decode(buffer));
			} catch (err) {
				// A malformed frame — or a message from a mismatched protocol
				// version — must not propagate into werift's emitter (it would
				// surface as an uncaught exception and kill the process).
				// Log and drop; the connection stays up.
				getLogger().warn(
					{ err: err instanceof Error ? err.message : String(err) },
					"dropping undecodable message",
				);
			}
		};
		this.channel.onclose = () => {
			this.notifyClose();
		};
	}

	send(message: Message): void {
		const buffer = encode(message);
		this.channel.send(Buffer.from(buffer));
	}

	/** Send a pre-framed binary payload (file chunks) with no JSON overhead. */
	sendBinary(frame: Uint8Array): void {
		this.channel.send(Buffer.from(frame));
	}

	/** Bytes queued in werift's DataChannel queue, not yet handed to SCTP. */
	get bufferedAmount(): number {
		return this.channel.bufferedAmount;
	}

	get isOpen(): boolean {
		return this.channel.readyState === "open";
	}

	/**
	 * Resolve once `bufferedAmount` drops to `thresholdBytes` or below;
	 * reject if the channel closes first. The `bufferedamountlow` event only
	 * fires on downward threshold crossings, so a pure event wait could miss
	 * an already-drained queue — a short poll races alongside it as a
	 * belt-and-braces fallback.
	 *
	 * Note "connecting" is NOT a failure: right after a handshake the
	 * channel queues sends while SCTP establishes, and the queue drains
	 * once the association comes up. Only closing/closed abort the wait.
	 */
	async waitForDrain(thresholdBytes: number, pollMs = DEFAULT_DRAIN_POLL_MS): Promise<void> {
		this.channel.bufferedAmountLowThreshold = thresholdBytes;
		while (this.channel.bufferedAmount > thresholdBytes) {
			if (this.channel.readyState !== "open" && this.channel.readyState !== "connecting") {
				throw new Error("Data channel closed during transfer");
			}
			await new Promise<void>((resolve, reject) => {
				const cleanup = () => {
					clearTimeout(timer);
					unsubscribeLow.unSubscribe();
					unsubscribeClose();
				};
				const timer = setTimeout(() => {
					cleanup();
					resolve();
				}, pollMs);
				const unsubscribeLow = this.channel.bufferedAmountLow.subscribe(() => {
					cleanup();
					resolve();
				});
				const unsubscribeClose = this.onClose(() => {
					cleanup();
					reject(new Error("Data channel closed during transfer"));
				});
			});
		}
		if (this.channel.readyState !== "open" && this.channel.readyState !== "connecting") {
			throw new Error("Data channel closed during transfer");
		}
	}

	onMessage(callback: (message: Message) => void): () => void {
		this.messageListeners.add(callback);
		return () => {
			this.messageListeners.delete(callback);
		};
	}

	/**
	 * Fires when the underlying channel reaches "closed" — including a
	 * REMOTE close (SCTP reconfig propagates it), which is how a peer that
	 * lost only its data channel stops looking "online".
	 */
	onClose(callback: () => void): () => void {
		this.closeListeners.add(callback);
		return () => {
			this.closeListeners.delete(callback);
		};
	}

	close(): void {
		this.channel.close();
	}

	private notifyClose(): void {
		if (this.closeNotified) return;
		this.closeNotified = true;
		for (const listener of this.closeListeners) {
			listener();
		}
	}

	private notifyListeners(message: Message): void {
		for (const listener of this.messageListeners) {
			listener(message);
		}
	}
}

function synthesizeFileChunk(frame: Uint8Array): FileChunkMessage {
	const { transferId, index, data } = decodeFileChunkFrame(frame);
	return {
		type: "file-chunk",
		id: crypto.randomUUID(),
		timestamp: Date.now(),
		payload: { transferId, index, data },
	};
}

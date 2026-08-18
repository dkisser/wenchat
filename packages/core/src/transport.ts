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

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

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
			let message: Message;
			try {
				if (typeof data === "string") {
					message = decode(new TextEncoder().encode(data));
				} else {
					const buffer = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
					message = isFileChunkFrame(buffer) ? synthesizeFileChunk(buffer) : decode(buffer);
				}
			} catch (err) {
				// A malformed frame — or a message from a mismatched protocol
				// version — must not propagate into werift's emitter (it would
				// surface as an uncaught exception and kill the process).
				// Log and drop; the connection stays up.
				getLogger().warn({ err: errorText(err) }, "dropping undecodable message");
				return;
			}
			// Fan-out lives OUTSIDE the decode try/catch: a throwing listener
			// is a bug in listener code, not an undecodable message.
			this.notifyListeners(message);
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
		// One throwing listener must not starve the rest of the fan-out —
		// each gets its own guard, here and in notifyListeners.
		for (const listener of this.closeListeners) {
			try {
				listener();
			} catch (err) {
				getLogger().error({ err: errorText(err) }, "close listener threw");
			}
		}
	}

	private notifyListeners(message: Message): void {
		for (const listener of this.messageListeners) {
			try {
				listener(message);
			} catch (err) {
				getLogger().error({ err: errorText(err) }, "message listener threw");
			}
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

import { decode, encode, type Message } from "@wenchat/protocol";
import type { RTCDataChannel } from "werift";

export class DataTransport {
	private channel: RTCDataChannel;
	private messageListeners: Set<(message: Message) => void> = new Set();

	constructor(channel: RTCDataChannel) {
		this.channel = channel;
		this.channel.onmessage = (event) => {
			const data = event.data as Buffer | Uint8Array | ArrayBuffer | string;
			if (typeof data === "string") {
				const message = decode(new TextEncoder().encode(data));
				this.notifyListeners(message);
				return;
			}
			const buffer = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
			const message = decode(buffer);
			this.notifyListeners(message);
		};
	}

	send(message: Message): void {
		const buffer = encode(message);
		this.channel.send(Buffer.from(buffer));
	}

	onMessage(callback: (message: Message) => void): () => void {
		this.messageListeners.add(callback);
		return () => {
			this.messageListeners.delete(callback);
		};
	}

	close(): void {
		this.channel.close();
	}

	private notifyListeners(message: Message): void {
		for (const listener of this.messageListeners) {
			listener(message);
		}
	}
}

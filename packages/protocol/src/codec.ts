import type { Message } from "./message.ts";

const MESSAGE_TYPES = new Set(["text", "file-start", "file-chunk", "file-end"]);

export function encode(message: Message): Uint8Array {
	const json = JSON.stringify(message, (_key, value) => {
		if (value instanceof Uint8Array) {
			return Array.from(value);
		}
		return value;
	});
	return new TextEncoder().encode(json);
}

export function decode(buffer: Uint8Array): Message {
	const json = new TextDecoder().decode(buffer);
	const parsed = JSON.parse(json) as unknown;

	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("Decoded value is not an object");
	}

	const message = parsed as Record<string, unknown>;
	const type = message.type;

	if (typeof type !== "string" || !MESSAGE_TYPES.has(type)) {
		throw new Error(`Unknown message type: ${type}`);
	}

	if (type === "file-chunk") {
		const payload = message.payload as Record<string, unknown>;
		const data = payload.data;
		if (!Array.isArray(data)) {
			throw new Error("File chunk data is not an array");
		}
		return {
			...message,
			payload: {
				...payload,
				data: new Uint8Array(data),
			},
		} as Message;
	}

	return message as Message;
}

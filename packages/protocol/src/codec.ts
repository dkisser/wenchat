import type { Message } from "./message";

const MESSAGE_TYPES = new Set(["text", "file-start", "file-chunk", "file-end", "ping", "pong"]);

/**
 * Deep-walk a value, converting every Uint8Array (including Node Buffers,
 * which extend Uint8Array) into a plain number array. Done before
 * JSON.stringify so Buffer's `toJSON` — which returns `{type:"Buffer",
 * data:[...]} and runs BEFORE the stringify replacer — can't poison the
 * payload. Anything that isn't a Uint8Array, array, or plain object is
 * returned as-is.
 */
function toJsonable(value: unknown): unknown {
	if (value instanceof Uint8Array) {
		return Array.from(value);
	}
	if (Array.isArray(value)) {
		return value.map(toJsonable);
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = toJsonable(v);
		}
		return out;
	}
	return value;
}

export function encode(message: Message): Uint8Array {
	const jsonable = toJsonable(message);
	return new TextEncoder().encode(JSON.stringify(jsonable));
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

import type { Message } from "./message";

/**
 * JSON codec for control-plane messages. File chunks never pass through here
 * — they use the binary framing in `frame.ts` — so no Uint8Array payload
 * survives to JSON.stringify and no special-casing is needed on decode.
 */
const MESSAGE_TYPES = new Set([
	"text",
	"file-start",
	"file-end",
	"file-abort",
	"ping",
	"pong",
	"bye",
]);

export function encode(message: Message): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(message));
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

	return message as Message;
}

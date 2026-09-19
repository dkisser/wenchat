import type { Message, Seq } from "./message";

/**
 * JSON codec for control-plane messages. File chunks never pass through here
 * — they use the binary framing in `frame.ts` — so no Uint8Array payload
 * survives to JSON.stringify EXCEPT for the `file-chunk-ack.bitmap` field,
 * which is converted to base64 by `toWire` and back to a Uint8Array by
 * `hydrateFileChunkAck` (ADR 0003 Q2 — bitmap is the chunk ACK payload).
 */
const MESSAGE_TYPES = new Set([
	"text",
	"file-start",
	"file-end",
	"file-abort",
	"ping",
	"pong",
	"bye",
	"message-ack",
	"file-chunk-ack",
]);

/**
 * Hard upper bound for a decoded seq. ADR 0003 Q1 mandates `u64`, but
 * JavaScript `number` is IEEE-754 double — anything above this loses
 * integer precision, so the codec rejects it defensively before the value
 * reaches the ACK scheduler (Stage 1 PR-3).
 */
const MAX_SAFE_SEQ = Number.MAX_SAFE_INTEGER;

export function encode(message: Message): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(toWire(message)));
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

	validateSeq(message.seq);

	if (type === "file-chunk-ack") {
		return hydrateFileChunkAck(message);
	}

	// Normalize missing seq to null (ADR 0003 Q11). Spread keeps the
	// returned object immutable w.r.t. the JSON-parsed input.
	const seq = (message.seq ?? null) as Seq;
	return { ...message, seq } as Message;
}

/**
 * Narrow the `seq` field before it reaches the higher layers. Per ADR 0003
 * Q11, missing/undefined is accepted (legacy frame); anything else must be
 * a non-negative integer no greater than `Number.MAX_SAFE_INTEGER`.
 */
function validateSeq(seq: unknown): void {
	if (seq === null || seq === undefined) return;
	if (typeof seq !== "number" || !Number.isFinite(seq)) {
		throw new Error(`Invalid seq: expected non-negative integer, got ${JSON.stringify(seq)}`);
	}
	if (seq < 0) {
		throw new Error(`Invalid seq: ${seq} (must be >= 0)`);
	}
	if (seq > MAX_SAFE_SEQ) {
		throw new Error(`Invalid seq: ${seq} exceeds Number.MAX_SAFE_INTEGER (${MAX_SAFE_SEQ})`);
	}
}

/**
 * Convert the in-memory message to its JSON-friendly wire form. Only
 * `file-chunk-ack` needs attention — its `bitmap` is a Uint8Array, which
 * JSON.stringify would serialize as an index map (`{"0":1,"1":0,...}`).
 * Base64 keeps the payload compact and unambiguous.
 */
function toWire(message: Message): unknown {
	if (message.type === "file-chunk-ack") {
		return {
			...message,
			payload: {
				...message.payload,
				bitmap: uint8ArrayToBase64(message.payload.bitmap),
			},
		};
	}
	return message;
}

/**
 * Build a fully-typed `file-chunk-ack` from the JSON-parsed record. The
 * bitmap field arrives as a base64 string; everything else is shape-checked
 * and surfaced with a clear error if a peer sends the wrong type.
 */
function hydrateFileChunkAck(message: Record<string, unknown>): Message {
	const payload = message.payload as Record<string, unknown> | undefined;
	if (payload === undefined || typeof payload !== "object" || payload === null) {
		throw new Error("file-chunk-ack payload must be an object");
	}
	const { transferId, bitmap, lastIndex } = payload;
	if (typeof transferId !== "string") {
		throw new Error("file-chunk-ack transferId must be a string");
	}
	if (typeof bitmap !== "string") {
		throw new Error("file-chunk-ack bitmap must be a base64 string");
	}
	if (typeof lastIndex !== "number" || !Number.isInteger(lastIndex) || lastIndex < 0) {
		throw new Error(`file-chunk-ack lastIndex must be a non-negative integer, got ${lastIndex}`);
	}
	return {
		type: "file-chunk-ack",
		id: message.id as string,
		timestamp: message.timestamp as number,
		seq: (message.seq ?? null) as Seq,
		payload: {
			transferId,
			bitmap: base64ToUint8Array(bitmap),
			lastIndex,
		},
	};
}

/**
 * Encode a Uint8Array as base64 using `btoa`. Chunked to keep the
 * `String.fromCharCode(...uint8)` call under the engine's argument-count
 * limit on large arrays (relevant for bitmaps covering many chunks).
 */
function uint8ArrayToBase64(arr: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < arr.length; i += chunkSize) {
		binary += String.fromCharCode(...arr.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array {
	const binary = atob(b64);
	const arr = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		arr[i] = binary.charCodeAt(i);
	}
	return arr;
}

import { z } from "zod";
import type { Message } from "./message";

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
 * JavaScript `number` is IEEE-754 double — `z.int()` (Zod v4) already
 * enforces the safe-integer range, so this is belt-and-suspenders plus a
 * self-documenting cap.
 */
const MAX_SAFE_SEQ = Number.MAX_SAFE_INTEGER;

/**
 * Per ADR 0003 Q11: seq is optional on the wire; when present, must be a
 * safe non-negative integer. `z.int()` is Zod v4's safe-integer-only
 * equivalent of `z.number().int()`; `.nullish()` accepts both `null`
 * (explicit legacy marker) and `undefined` (field absent).
 */
const SeqSchema = z
	.int({ error: "seq must be an integer" })
	.min(0, { error: "seq must be >= 0" })
	.max(MAX_SAFE_SEQ, { error: `seq must be <= ${MAX_SAFE_SEQ}` })
	.nullish();

/**
 * File-chunk-ack payload (ADR 0003 Q2 + Q8). `bitmap` is base64 on the wire;
 * `z.base64()` validates alphabet + length + padding in v4.6. `transferId`
 * stays as a plain `z.string()` — the existing tests use a non-RFC-4122
 * hex-grouped id ("01234567-89ab-cdef-...") that would fail `z.uuid()`.
 */
const FileChunkAckPayloadSchema = z.object({
	transferId: z.string({ error: "transferId must be a string" }),
	bitmap: z.base64({ error: "bitmap must be a valid base64 string" }),
	lastIndex: z.int().min(0, { error: "lastIndex must be >= 0" }),
});

/**
 * Decode helper: turn a ZodError into a single-line, human-readable string
 * suitable for an `Error` message. `z.prettifyError` is the v4-recommended
 * helper (instance `.format()` / `.flatten()` are deprecated).
 */
function formatZodError(err: z.ZodError): string {
	return z.prettifyError(err);
}

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

	const seqResult = SeqSchema.safeParse(message.seq);
	if (!seqResult.success) {
		throw new Error(`Invalid seq: ${formatZodError(seqResult.error)}`);
	}

	if (type === "file-chunk-ack") {
		return hydrateFileChunkAck(message);
	}

	// Normalize missing seq to null (ADR 0003 Q11). Spread keeps the
	// returned object immutable w.r.t. the JSON-parsed input.
	return { ...message, seq: seqResult.data ?? null } as Message;
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
 * by Zod and surfaced with a clear error if a peer sends the wrong type.
 */
function hydrateFileChunkAck(message: Record<string, unknown>): Message {
	const payloadResult = FileChunkAckPayloadSchema.safeParse(message.payload);
	if (!payloadResult.success) {
		throw new Error(`Invalid file-chunk-ack payload: ${formatZodError(payloadResult.error)}`);
	}
	const { transferId, bitmap, lastIndex } = payloadResult.data;
	return {
		type: "file-chunk-ack",
		id: message.id as string,
		timestamp: message.timestamp as number,
		seq: SeqSchema.parse(message.seq) ?? null,
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

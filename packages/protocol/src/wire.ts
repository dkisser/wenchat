import { decode } from "./codec";
import { type FileChunkFramePayload, decodeFileChunkFrame, isFileChunkFrame } from "./frame";
import type { Message } from "./message";

/**
 * Thin demux adapter over one inbound datagram.
 *
 * Two wire formats share a DataChannel: JSON control-plane messages
 * (`codec.ts`) and binary file-chunk frames (`frame.ts`). Deciding which
 * one arrived is a protocol concern — the magic byte lives here, next to
 * both codecs — so the transport layer only ships bytes and dispatches on
 * `kind`. Chunks surface as their decoded frame payload, NOT dressed up
 * as a `Message`: a chunk has no id/timestamp on the wire, and inventing
 * them would poison any future dedup-by-id or latency logic.
 */
export type WirePacket =
	| { kind: "message"; message: Message }
	| { kind: "file-chunk"; chunk: FileChunkFramePayload };

/**
 * Demux and decode one inbound datagram. Throws on malformed input
 * (neither valid JSON with a known type nor a well-formed chunk frame) —
 * the caller decides whether to drop the datagram or kill the connection.
 */
export function decodeWirePacket(data: Uint8Array | string): WirePacket {
	const buffer = typeof data === "string" ? new TextEncoder().encode(data) : data;
	if (isFileChunkFrame(buffer)) {
		return { kind: "file-chunk", chunk: decodeFileChunkFrame(buffer) };
	}
	return { kind: "message", message: decode(buffer) };
}

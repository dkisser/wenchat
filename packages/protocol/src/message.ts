/**
 * Per-peer monotonic sequence number for application messages.
 *
 * ADR 0003 Q1 mandates `u64`. JavaScript `number` is an IEEE-754 double,
 * which represents integers exactly only up to `Number.MAX_SAFE_INTEGER`
 * (~9.007e15). The codec enforces that bound at decode time (see
 * `packages/protocol/src/codec.ts`).
 *
 * `null` (or, before the codec has run, absent) means "no seq" — the frame
 * predates Stage 1 and the receiver treats it as in-order (ADR 0003 Q11).
 */
export type Seq = number | null;

/**
 * Common envelope fields every control-plane message carries on the wire.
 *
 * Stage 1 (ADR 0001, ADR 0003) added `seq`; the codec writes it as `null`
 * for legacy frames. `id` and `timestamp` were already present pre-Stage-1.
 */
export type MessageEnvelope = {
	id: string;
	timestamp: number;
	/** Per-peer monotonic seq (u64, capped at Number.MAX_SAFE_INTEGER). */
	seq?: Seq;
};

export type TextMessage = MessageEnvelope & {
	type: "text";
	payload: { text: string };
};

export type FileStartMessage = MessageEnvelope & {
	type: "file-start";
	payload: {
		transferId: string;
		fileName: string;
		fileSize: number;
		chunkSize: number;
	};
};

export type FileEndMessage = MessageEnvelope & {
	type: "file-end";
	payload: {
		transferId: string;
		/** sha256 hex of the full file, computed incrementally by the sender. */
		checksum: string;
	};
};

/** Sent by either side when a transfer dies mid-flight so the peer can clean up. */
export type FileAbortMessage = MessageEnvelope & {
	type: "file-abort";
	payload: {
		transferId: string;
		reason: string;
	};
};

// Heartbeat ping — sent on a fixed cadence by each connected peer.
// `nonce` correlates the request with the peer's pong.
export type PingMessage = MessageEnvelope & {
	type: "ping";
	payload: { nonce: string };
};

// Heartbeat pong — mirrors the nonce of the triggering ping.
export type PongMessage = MessageEnvelope & {
	type: "pong";
	payload: { nonce: string };
};

/**
 * Why a peer is tearing the session down.
 *
 * `exit` — the peer is quitting the process entirely.
 * `disconnect` — the peer stays in the app, it just dropped this session.
 *
 * The distinction is purely cosmetic to the receiver (both mean "do not
 * auto-retry"), but it lets the UI say "left the chat" vs "disconnected".
 */
export type ByeReason = "exit" | "disconnect";

/**
 * Graceful-close signal, sent right before a local teardown.
 *
 * WebRTC carries no *intent*: a peer calling `pc.close()` and a peer whose
 * Wi-Fi died produce the identical `closed` event on the other end. Without
 * this message the receiver has to assume every close is a network blip and
 * burns a full reconnect-backoff window on a peer that deliberately left.
 *
 * Best-effort by design — a peer running an older protocol drops the unknown
 * type (see `DataTransport`'s decode guard) and simply falls back to the
 * network-loss path.
 */
export type ByeMessage = MessageEnvelope & {
	type: "bye";
	payload: { reason: ByeReason };
};

/**
 * Single-value ACK for application messages (ADR 0003 Q2).
 *
 * `ack` is the highest contiguous seq the receiver has received from the
 * sender. The sender uses this to advance the outbox head and stop
 * retransmitting. Fires on whichever happens first: 200 ms idle, every 16
 * inbound messages, or session close (ADR 0003 Q3).
 */
export type MessageAckMessage = MessageEnvelope & {
	type: "message-ack";
	payload: { ack: number };
};

/**
 * Per-transfer chunk bitmap ACK for file transfers (ADR 0003 Q2, Q8, F.5).
 *
 * `bitmap` is a compact bit-per-chunk view of the chunks the receiver has
 * for this `transferId`; bit `i` set means the receiver has chunk index `i`.
 * `lastIndex` is the highest chunk index the sender has assigned for this
 * transfer, so the receiver knows how many bits the bitmap covers.
 *
 * Chunks do NOT flow through the outbox (ADR 0003 F.5): the bitmap is the
 * only recovery channel. The codec serializes `bitmap` as base64 so the
 * payload stays valid JSON.
 */
export type FileChunkAckMessage = MessageEnvelope & {
	type: "file-chunk-ack";
	payload: {
		transferId: string;
		/** 1 bit per chunk index; LSB-first within each byte. */
		bitmap: Uint8Array;
		/** Highest chunk index the sender has assigned for this transfer. */
		lastIndex: number;
	};
};

export type Message =
	| TextMessage
	| FileStartMessage
	| FileEndMessage
	| FileAbortMessage
	| PingMessage
	| PongMessage
	| ByeMessage
	| MessageAckMessage
	| FileChunkAckMessage;

export type PeerInfo = {
	id: string;
	displayName: string;
	signalingHost: string;
	signalingPort: number;
};

export function createPing(nonce: string, id: string = crypto.randomUUID()): PingMessage {
	return {
		type: "ping",
		id,
		timestamp: Date.now(),
		seq: null,
		payload: { nonce },
	};
}

export function createPong(nonce: string, id: string = crypto.randomUUID()): PongMessage {
	return {
		type: "pong",
		id,
		timestamp: Date.now(),
		seq: null,
		payload: { nonce },
	};
}

export function createBye(reason: ByeReason, id: string = crypto.randomUUID()): ByeMessage {
	return {
		type: "bye",
		id,
		timestamp: Date.now(),
		seq: null,
		payload: { reason },
	};
}

/**
 * Build a `message-ack` frame. `seq` is left as `null` for receivers (ACKs
 * travel outbound but the codec assigns their seq on the wire path); senders
 * in PR-3 should pass the assigned seq directly to avoid a spread on the hot
 * send path.
 */
export function createMessageAck(
	ack: number,
	seq: Seq = null,
	id: string = crypto.randomUUID(),
): MessageAckMessage {
	return {
		type: "message-ack",
		id,
		timestamp: Date.now(),
		seq,
		payload: { ack },
	};
}

/**
 * Build a `file-chunk-ack` frame. Same `seq` policy as `createMessageAck`:
 * pass the assigned seq at construction time when known.
 */
export function createFileChunkAck(
	transferId: string,
	bitmap: Uint8Array,
	lastIndex: number,
	seq: Seq = null,
	id: string = crypto.randomUUID(),
): FileChunkAckMessage {
	return {
		type: "file-chunk-ack",
		id,
		timestamp: Date.now(),
		seq,
		payload: { transferId, bitmap, lastIndex },
	};
}

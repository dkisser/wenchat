export type TextMessage = {
	type: "text";
	id: string;
	timestamp: number;
	payload: { text: string };
};

export type FileStartMessage = {
	type: "file-start";
	id: string;
	timestamp: number;
	payload: {
		transferId: string;
		fileName: string;
		fileSize: number;
		chunkSize: number;
	};
};

/**
 * In-process representation of one file chunk. On the wire chunks travel as
 * binary frames (see `frame.ts`), never as JSON — the transport synthesizes
 * this message from a decoded frame so listeners keep a uniform shape.
 */
export type FileChunkMessage = {
	type: "file-chunk";
	id: string;
	timestamp: number;
	payload: {
		transferId: string;
		index: number;
		data: Uint8Array;
	};
};

export type FileEndMessage = {
	type: "file-end";
	id: string;
	timestamp: number;
	payload: {
		transferId: string;
		/** sha256 hex of the full file, computed incrementally by the sender. */
		checksum: string;
	};
};

/** Sent by either side when a transfer dies mid-flight so the peer can clean up. */
export type FileAbortMessage = {
	type: "file-abort";
	id: string;
	timestamp: number;
	payload: {
		transferId: string;
		reason: string;
	};
};

// Heartbeat ping — sent on a fixed cadence by each connected peer.
// `nonce` correlates the request with the peer's pong.
export type PingMessage = {
	type: "ping";
	id: string;
	timestamp: number;
	payload: { nonce: string };
};

// Heartbeat pong — mirrors the nonce of the triggering ping.
export type PongMessage = {
	type: "pong";
	id: string;
	timestamp: number;
	payload: { nonce: string };
};

export type Message =
	| TextMessage
	| FileStartMessage
	| FileChunkMessage
	| FileEndMessage
	| FileAbortMessage
	| PingMessage
	| PongMessage;

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
		payload: { nonce },
	};
}

export function createPong(nonce: string, id: string = crypto.randomUUID()): PongMessage {
	return {
		type: "pong",
		id,
		timestamp: Date.now(),
		payload: { nonce },
	};
}

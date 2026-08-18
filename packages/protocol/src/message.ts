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

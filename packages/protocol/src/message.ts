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
export type ByeMessage = {
	type: "bye";
	id: string;
	timestamp: number;
	payload: { reason: ByeReason };
};

export type Message =
	| TextMessage
	| FileStartMessage
	| FileEndMessage
	| FileAbortMessage
	| PingMessage
	| PongMessage
	| ByeMessage;

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

export function createBye(reason: ByeReason, id: string = crypto.randomUUID()): ByeMessage {
	return {
		type: "bye",
		id,
		timestamp: Date.now(),
		payload: { reason },
	};
}

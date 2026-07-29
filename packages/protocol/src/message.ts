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
		checksum: string;
	};
};

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
	};
};

export type Message = TextMessage | FileStartMessage | FileChunkMessage | FileEndMessage;

export type PeerInfo = {
	id: string;
	displayName: string;
	signalingHost: string;
	signalingPort: number;
};

import type { FileAbortMessage, FileEndMessage, FileStartMessage } from "./message";

/**
 * Announce a new transfer. Carries no checksum — a streaming sender cannot
 * know the sha256 before it has read the file; integrity is verified from
 * `file-end` instead.
 */
export function createFileStart(
	fileName: string,
	fileSize: number,
	chunkSize: number,
	transferId: string = crypto.randomUUID(),
): FileStartMessage {
	return {
		type: "file-start",
		id: crypto.randomUUID(),
		timestamp: Date.now(),
		payload: {
			transferId,
			fileName,
			fileSize,
			chunkSize,
		},
	};
}

/** Declare a transfer complete. `checksum` is the sha256 hex of the whole file. */
export function createFileEnd(transferId: string, checksum: string): FileEndMessage {
	return {
		type: "file-end",
		id: crypto.randomUUID(),
		timestamp: Date.now(),
		payload: { transferId, checksum },
	};
}

/** Tell the peer a transfer died mid-flight so it can drop partial state. */
export function createFileAbort(transferId: string, reason: string): FileAbortMessage {
	return {
		type: "file-abort",
		id: crypto.randomUUID(),
		timestamp: Date.now(),
		payload: { transferId, reason },
	};
}

import type { FileChunkMessage, FileStartMessage } from "./message";

export function createFileStart(
	fileName: string,
	file: Uint8Array,
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
			fileSize: file.length,
			chunkSize,
			checksum: computeChecksum(file),
		},
	};
}

export function createFileChunks(
	file: Uint8Array,
	chunkSize: number,
	transferId: string = crypto.randomUUID(),
): FileChunkMessage[] {
	const chunks: FileChunkMessage[] = [];
	for (let i = 0; i < file.length; i += chunkSize) {
		const slice = file.slice(i, i + chunkSize);
		chunks.push({
			type: "file-chunk",
			id: crypto.randomUUID(),
			timestamp: Date.now(),
			payload: {
				transferId,
				index: chunks.length,
				data: slice,
			},
		});
	}
	return chunks;
}

export function reassembleFile(chunks: FileChunkMessage[]): Uint8Array {
	const sorted = [...chunks].sort((a, b) => a.payload.index - b.payload.index);
	const totalLength = sorted.reduce((sum, chunk) => sum + chunk.payload.data.length, 0);
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of sorted) {
		result.set(chunk.payload.data, offset);
		offset += chunk.payload.data.length;
	}
	return result;
}

export function computeChecksum(data: Uint8Array): string {
	let hash = 0;
	for (const byte of data) {
		hash = (hash << 5) - hash + byte;
		hash |= 0;
	}
	return hash.toString(16);
}

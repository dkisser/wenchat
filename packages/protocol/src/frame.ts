/**
 * Binary framing for file chunks.
 *
 * Chunks are the only high-volume message in the protocol, so they travel as
 * compact binary frames instead of JSON (the old number-array encoding made
 * every 16 KiB chunk ~50 KiB on the wire and tripled memory pressure on a
 * large transfer). Everything else — text, heartbeat, file-start/end/abort —
 * stays JSON; the magic byte makes the two formats unambiguous on receive
 * (valid JSON can never start with 0xA1).
 *
 * Layout (22-byte header + payload):
 *   byte  0      magic 0xA1
 *   byte  1      frame version (1)
 *   bytes 2-5    chunk index, uint32 little-endian
 *   bytes 6-21   transferId UUID, 16 raw bytes (dashes stripped)
 *   bytes 22..   chunk payload
 */

export const FILE_CHUNK_MAGIC = 0xa1;
export const FILE_CHUNK_VERSION = 1;
export const FILE_CHUNK_HEADER_BYTES = 22;

const UUID_HEX_LENGTH = 32;

export function encodeFileChunkFrame(
	transferId: string,
	index: number,
	data: Uint8Array,
): Uint8Array {
	const idBytes = uuidToBytes(transferId);
	const frame = new Uint8Array(FILE_CHUNK_HEADER_BYTES + data.length);
	frame[0] = FILE_CHUNK_MAGIC;
	frame[1] = FILE_CHUNK_VERSION;
	const view = new DataView(frame.buffer);
	view.setUint32(2, index, true);
	frame.set(idBytes, 6);
	frame.set(data, FILE_CHUNK_HEADER_BYTES);
	return frame;
}

export function isFileChunkFrame(buffer: Uint8Array): boolean {
	return buffer.length >= FILE_CHUNK_HEADER_BYTES && buffer[0] === FILE_CHUNK_MAGIC;
}

export function decodeFileChunkFrame(buffer: Uint8Array): {
	transferId: string;
	index: number;
	data: Uint8Array;
} {
	if (buffer.length < FILE_CHUNK_HEADER_BYTES) {
		throw new Error(`File chunk frame too short: ${buffer.length} bytes`);
	}
	if (buffer[0] !== FILE_CHUNK_MAGIC) {
		throw new Error(`Bad file chunk frame magic: 0x${buffer[0]?.toString(16)}`);
	}
	if (buffer[1] !== FILE_CHUNK_VERSION) {
		throw new Error(`Unsupported file chunk frame version: ${buffer[1]}`);
	}
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	const index = view.getUint32(2, true);
	const transferId = bytesToUuid(buffer.subarray(6, 22));
	return {
		transferId,
		index,
		data: buffer.subarray(FILE_CHUNK_HEADER_BYTES),
	};
}

function uuidToBytes(uuid: string): Uint8Array {
	const hex = uuid.replaceAll("-", "");
	if (hex.length !== UUID_HEX_LENGTH || !/^[0-9a-fA-F]+$/.test(hex)) {
		throw new Error(`Malformed transferId (expected a UUID): ${uuid}`);
	}
	const bytes = new Uint8Array(16);
	for (let i = 0; i < 16; i++) {
		bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

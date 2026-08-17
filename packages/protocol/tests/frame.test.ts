import { describe, expect, it } from "bun:test";
import {
	FILE_CHUNK_HEADER_BYTES,
	FILE_CHUNK_MAGIC,
	FILE_CHUNK_VERSION,
	decodeFileChunkFrame,
	encodeFileChunkFrame,
	isFileChunkFrame,
} from "../src/frame";

const TRANSFER_ID = "01234567-89ab-cdef-0123-456789abcdef";

describe("file chunk framing", () => {
	it("round-trips a chunk", () => {
		const data = new Uint8Array([1, 2, 3, 250, 255]);
		const frame = encodeFileChunkFrame(TRANSFER_ID, 7, data);
		expect(frame.length).toBe(FILE_CHUNK_HEADER_BYTES + data.length);
		expect(frame[0]).toBe(FILE_CHUNK_MAGIC);
		expect(frame[1]).toBe(FILE_CHUNK_VERSION);

		const decoded = decodeFileChunkFrame(frame);
		expect(decoded.transferId).toBe(TRANSFER_ID);
		expect(decoded.index).toBe(7);
		expect(new Uint8Array(decoded.data)).toEqual(data);
	});

	it("round-trips a zero-length payload", () => {
		const frame = encodeFileChunkFrame(TRANSFER_ID, 0, new Uint8Array(0));
		const decoded = decodeFileChunkFrame(frame);
		expect(decoded.data.length).toBe(0);
	});

	it("round-trips a 64 KiB payload and the maximum index", () => {
		const data = new Uint8Array(64 * 1024).map((_, i) => i % 251);
		const decoded = decodeFileChunkFrame(encodeFileChunkFrame(TRANSFER_ID, 0xffffffff, data));
		expect(decoded.index).toBe(0xffffffff);
		expect(decoded.data.length).toBe(64 * 1024);
		expect(decoded.data[12345]).toBe(data[12345]);
	});

	it("round-trips an uppercase UUID to lowercase canonical form", () => {
		const upper = TRANSFER_ID.toUpperCase();
		const decoded = decodeFileChunkFrame(encodeFileChunkFrame(upper, 0, new Uint8Array(0)));
		expect(decoded.transferId).toBe(TRANSFER_ID);
	});

	it("isFileChunkFrame rejects JSON payloads and short buffers", () => {
		expect(isFileChunkFrame(new TextEncoder().encode('{"type":"text"}'))).toBe(false);
		expect(isFileChunkFrame(new Uint8Array([FILE_CHUNK_MAGIC, 1, 0]))).toBe(false);
		expect(isFileChunkFrame(new Uint8Array(0))).toBe(false);
	});

	it("decode throws on bad magic", () => {
		const frame = encodeFileChunkFrame(TRANSFER_ID, 0, new Uint8Array(1));
		frame[0] = 0x00;
		expect(() => decodeFileChunkFrame(frame)).toThrow("magic");
	});

	it("decode throws on an unsupported version", () => {
		const frame = encodeFileChunkFrame(TRANSFER_ID, 0, new Uint8Array(1));
		frame[1] = 99;
		expect(() => decodeFileChunkFrame(frame)).toThrow("version");
	});

	it("decode throws on a truncated header", () => {
		const frame = encodeFileChunkFrame(TRANSFER_ID, 0, new Uint8Array(1));
		expect(() => decodeFileChunkFrame(frame.subarray(0, 10))).toThrow("too short");
	});

	it("encode throws on a malformed transferId", () => {
		expect(() => encodeFileChunkFrame("not-a-uuid", 0, new Uint8Array(1))).toThrow(
			"Malformed transferId",
		);
	});
});

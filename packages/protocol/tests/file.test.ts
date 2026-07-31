import { describe, expect, it } from "bun:test";
import { computeChecksum, createFileChunks, createFileStart, reassembleFile } from "../src/file";

describe("file transfer", () => {
	it("splits file into chunks", () => {
		const file = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		const start = createFileStart("test.bin", file, 3);
		const chunks = createFileChunks(file, 3);

		expect(start.payload.fileName).toBe("test.bin");
		expect(start.payload.fileSize).toBe(10);
		expect(chunks.length).toBe(4);
		expect(chunks[0].payload.index).toBe(0);
		expect(chunks[3].payload.data.length).toBe(1);
	});

	it("reassembles chunks in order", () => {
		const file = new Uint8Array([1, 2, 3, 4, 5]);
		const chunks = createFileChunks(file, 2);
		const restored = reassembleFile(chunks);
		expect(restored).toEqual(file);
	});

	it("computes consistent checksum", () => {
		const a = new Uint8Array([1, 2, 3]);
		const b = new Uint8Array([1, 2, 3]);
		expect(computeChecksum(a)).toBe(computeChecksum(b));
	});
});

import { describe, expect, it } from "bun:test";
import { createFileAbort, createFileEnd, createFileStart } from "../src/file";

describe("file transfer messages", () => {
	it("createFileStart carries name, size, chunk size and transfer id", () => {
		const start = createFileStart("test.bin", 10, 3, "tid-1");
		expect(start.type).toBe("file-start");
		expect(start.payload).toEqual({
			transferId: "tid-1",
			fileName: "test.bin",
			fileSize: 10,
			chunkSize: 3,
		});
	});

	it("createFileStart generates a transfer id when omitted", () => {
		const start = createFileStart("test.bin", 0, 3);
		expect(start.payload.transferId.length).toBeGreaterThan(0);
	});

	it("createFileEnd carries the sha256 checksum", () => {
		const end = createFileEnd("tid-1", "deadbeef");
		expect(end.type).toBe("file-end");
		expect(end.payload).toEqual({ transferId: "tid-1", checksum: "deadbeef" });
	});

	it("createFileAbort carries the reason", () => {
		const abort = createFileAbort("tid-1", "disk full");
		expect(abort.type).toBe("file-abort");
		expect(abort.payload).toEqual({ transferId: "tid-1", reason: "disk full" });
	});
});

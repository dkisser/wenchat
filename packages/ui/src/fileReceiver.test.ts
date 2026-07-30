import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileReceiver, saveCompletedTransfer, uniqueDownloadPath } from "./fileReceiver";
import type { FileChunkMessage, FileStartMessage } from "@wenchat/protocol";

function startMessage(overrides: Partial<FileStartMessage["payload"]> = {}): FileStartMessage {
	return {
		type: "file-start",
		id: "start-1",
		timestamp: 0,
		payload: {
			transferId: "t-1",
			fileName: "report.md",
			fileSize: 100,
			chunkSize: 50,
			checksum: "deadbeef",
			...overrides,
		},
	};
}

function chunkMessage(index: number, data: number[], transferId = "t-1"): FileChunkMessage {
	return {
		type: "file-chunk",
		id: `chunk-${index}`,
		timestamp: 0,
		payload: {
			transferId,
			index,
			data: new Uint8Array(data),
		},
	};
}

describe("FileReceiver", () => {
	it("emits nothing until all expected chunks arrive", () => {
		const rx = new FileReceiver();
		rx.onStart(startMessage({ fileSize: 4, chunkSize: 2 }));
		expect(rx.onChunk(chunkMessage(0, [1, 2]))).toBeNull();
	});

	it("reassembles chunks in the correct order", () => {
		const rx = new FileReceiver();
		rx.onStart(startMessage({ fileSize: 6, chunkSize: 2 }));
		rx.onChunk(chunkMessage(1, [3, 4]));
		rx.onChunk(chunkMessage(2, [5, 6]));
		const completed = rx.onChunk(chunkMessage(0, [1, 2]));
		expect(completed).not.toBeNull();
		expect(completed?.fileName).toBe("report.md");
		expect(Array.from(completed?.bytes ?? [])).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it("treats a zero-byte file as a single empty chunk", () => {
		const rx = new FileReceiver();
		rx.onStart(startMessage({ fileSize: 0, chunkSize: 16 }));
		expect(rx.onChunk(chunkMessage(0, []))?.bytes.byteLength).toBe(0);
	});

	it("drops chunks for unknown transfers", () => {
		const rx = new FileReceiver();
		expect(rx.onChunk(chunkMessage(0, [1, 2, 3], "missing"))).toBeNull();
	});
});

describe("uniqueDownloadPath", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "wenchat-receiver-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns the bare path when no collision", async () => {
		expect(await uniqueDownloadPath(dir, "foo.md")).toBe(join(dir, "foo.md"));
	});

	it("falls back to ' (1)' suffix on collision", async () => {
		await writeFile(join(dir, "foo.md"), "first");
		expect(await uniqueDownloadPath(dir, "foo.md")).toBe(join(dir, "foo (1).md"));
	});

	it("counts up to ' (2)', ' (3)', ... for repeated collisions", async () => {
		await writeFile(join(dir, "foo.md"), "first");
		await writeFile(join(dir, "foo (1).md"), "second");
		expect(await uniqueDownloadPath(dir, "foo.md")).toBe(join(dir, "foo (2).md"));
	});

	it("strips directory components before saving", async () => {
		expect(await uniqueDownloadPath(dir, "/tmp/secret/foo.md")).toBe(join(dir, "foo.md"));
	});
});

describe("saveCompletedTransfer", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "wenchat-save-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("writes bytes and returns the final path", async () => {
		const path = await saveCompletedTransfer(dir, {
			fileName: "hello.txt",
			bytes: new Uint8Array([72, 73]),
		});
		expect(path).toBe(join(dir, "hello.txt"));
		expect(await readFile(path, "utf-8")).toBe("HI");
	});

	it("creates the directory if it does not exist", async () => {
		const nested = join(dir, "sub", "deep");
		const path = await saveCompletedTransfer(nested, {
			fileName: "x.txt",
			bytes: new Uint8Array([1]),
		});
		expect(path.startsWith(nested)).toBe(true);
	});
});
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FileChunkMessage,
	type Message,
	decodeFileChunkFrame,
	encodeFileChunkFrame,
} from "@wenchat/protocol";
import {
	BUFFERED_AMOUNT_HIGH_WATER,
	FILE_CHUNK_SIZE,
	FileReceiver,
	type SendChannel,
	type TransferEvent,
	sendFile,
	uniqueDownloadPath,
} from "../../src/fileTransfer";

let scratchDir: string;

beforeEach(async () => {
	scratchDir = await mkdtemp(join(tmpdir(), "wenchat-transfer-"));
});

afterEach(async () => {
	await rm(scratchDir, { recursive: true, force: true });
});

function sha256Hex(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function makeFakeChannel() {
	return {
		sent: [] as Message[],
		frames: [] as { transferId: string; index: number; data: Uint8Array }[],
		bufferedAmount: 0,
		isOpen: true,
		drainThresholds: [] as number[],
		send(message: Message) {
			this.sent.push(message);
		},
		sendBinary(frame: Uint8Array) {
			this.frames.push(decodeFileChunkFrame(frame));
		},
		async waitForDrain(threshold: number) {
			this.drainThresholds.push(threshold);
		},
	};
}

function chunkMessage(transferId: string, index: number, data: Uint8Array): FileChunkMessage {
	return {
		type: "file-chunk",
		id: `chunk-${index}`,
		timestamp: 0,
		payload: { transferId, index, data },
	};
}

describe("sendFile", () => {
	it("sends start → frames → end with a correct sha256", async () => {
		const size = FILE_CHUNK_SIZE * 2 + 123; // two full chunks + a tail
		const content = randomBytes(size);
		const path = join(scratchDir, "payload.bin");
		await writeFile(path, content);
		const channel = makeFakeChannel();

		const result = await sendFile(channel as unknown as SendChannel, path);

		const start = channel.sent[0];
		expect(start?.type).toBe("file-start");
		if (start?.type !== "file-start") throw new Error("unreachable");
		expect(start.payload.fileName).toBe("payload.bin");
		expect(start.payload.fileSize).toBe(size);
		expect(start.payload.chunkSize).toBe(FILE_CHUNK_SIZE);

		expect(channel.frames.length).toBe(3);
		expect(channel.frames.map((f) => f.index)).toEqual([0, 1, 2]);
		for (const frame of channel.frames) {
			expect(frame.transferId).toBe(start.payload.transferId);
		}
		const reassembled = Buffer.concat(channel.frames.map((f) => Buffer.from(f.data)));
		expect(new Uint8Array(reassembled)).toEqual(new Uint8Array(content));

		const end = channel.sent[1];
		expect(end?.type).toBe("file-end");
		if (end?.type !== "file-end") throw new Error("unreachable");
		expect(end.payload.checksum).toBe(sha256Hex(content));
		expect(result.bytesSent).toBe(size);
		expect(result.checksum).toBe(sha256Hex(content));
	});

	it("waits for the queue to drain when over the high-water mark", async () => {
		const path = join(scratchDir, "big.bin");
		await writeFile(path, randomBytes(FILE_CHUNK_SIZE * 3));
		const channel = makeFakeChannel();
		channel.bufferedAmount = BUFFERED_AMOUNT_HIGH_WATER + 1;

		await sendFile(channel as unknown as SendChannel, path);

		expect(channel.drainThresholds.length).toBeGreaterThan(0);
		expect(channel.drainThresholds[0]).toBe(BUFFERED_AMOUNT_HIGH_WATER / 2);
	});

	it("refuses a directory before anything is sent", async () => {
		const channel = makeFakeChannel();
		await expect(sendFile(channel as unknown as SendChannel, scratchDir)).rejects.toThrow(
			"Not a regular file",
		);
		expect(channel.sent.length).toBe(0);
		expect(channel.frames.length).toBe(0);
	});

	it("sends file-abort and rethrows when the channel dies mid-transfer", async () => {
		const path = join(scratchDir, "boom.bin");
		await writeFile(path, randomBytes(FILE_CHUNK_SIZE * 2));
		const channel = makeFakeChannel();
		let sends = 0;
		channel.sendBinary = () => {
			sends++;
			if (sends === 2) throw new Error("channel exploded");
		};

		await expect(sendFile(channel as unknown as SendChannel, path)).rejects.toThrow(
			"channel exploded",
		);
		const abort = channel.sent.find((m) => m.type === "file-abort");
		expect(abort?.type).toBe("file-abort");
	});

	it("sends only start and end for a zero-byte file", async () => {
		const path = join(scratchDir, "empty.bin");
		await writeFile(path, new Uint8Array(0));
		const channel = makeFakeChannel();

		const result = await sendFile(channel as unknown as SendChannel, path);

		expect(channel.frames.length).toBe(0);
		expect(channel.sent.map((m) => m.type)).toEqual(["file-start", "file-end"]);
		expect(result.bytesSent).toBe(0);
		expect(result.checksum).toBe(sha256Hex(new Uint8Array(0)));
	});
});

describe("FileReceiver", () => {
	function collectEvents(): { events: TransferEvent[]; sink: (e: TransferEvent) => void } {
		const events: TransferEvent[] = [];
		return { events, sink: (e) => events.push(e) };
	}

	it("writes a complete transfer to a temp file then renames it into place", async () => {
		const { events, sink } = collectEvents();
		const receiver = new FileReceiver({ downloadDir: scratchDir, onEvent: sink });
		const content = randomBytes(FILE_CHUNK_SIZE + 500);
		const transferId = crypto.randomUUID();

		receiver.handleMessage({
			type: "file-start",
			id: "s",
			timestamp: 0,
			payload: {
				transferId,
				fileName: "hello.bin",
				fileSize: content.length,
				chunkSize: FILE_CHUNK_SIZE,
			},
		});
		receiver.handleMessage(chunkMessage(transferId, 0, content.subarray(0, FILE_CHUNK_SIZE)));
		receiver.handleMessage(chunkMessage(transferId, 1, content.subarray(FILE_CHUNK_SIZE)));
		receiver.handleMessage({
			type: "file-end",
			id: "e",
			timestamp: 0,
			payload: { transferId, checksum: sha256Hex(content) },
		});
		await receiver.dispose();

		const completed = events.find((e) => e.kind === "completed");
		expect(completed?.kind).toBe("completed");
		if (completed?.kind !== "completed") throw new Error("unreachable");
		expect(completed.path).toBe(join(scratchDir, "hello.bin"));
		expect(new Uint8Array(await readFile(completed.path))).toEqual(new Uint8Array(content));
		expect(events.some((e) => e.kind === "failed")).toBe(false);
	});

	it("picks a non-colliding name when the file already exists", async () => {
		await writeFile(join(scratchDir, "dup.bin"), "existing");
		const { events, sink } = collectEvents();
		const receiver = new FileReceiver({ downloadDir: scratchDir, onEvent: sink });
		const content = new Uint8Array([1, 2, 3]);
		const transferId = crypto.randomUUID();

		receiver.handleMessage({
			type: "file-start",
			id: "s",
			timestamp: 0,
			payload: { transferId, fileName: "dup.bin", fileSize: 3, chunkSize: FILE_CHUNK_SIZE },
		});
		receiver.handleMessage(chunkMessage(transferId, 0, content));
		receiver.handleMessage({
			type: "file-end",
			id: "e",
			timestamp: 0,
			payload: { transferId, checksum: sha256Hex(content) },
		});
		await receiver.dispose();

		const completed = events.find((e) => e.kind === "completed");
		if (completed?.kind !== "completed") throw new Error("unreachable");
		expect(completed.path).toBe(join(scratchDir, "dup (1).bin"));
	});

	it("deletes the temp file and fails on checksum mismatch", async () => {
		const { events, sink } = collectEvents();
		const receiver = new FileReceiver({ downloadDir: scratchDir, onEvent: sink });
		const transferId = crypto.randomUUID();

		receiver.handleMessage({
			type: "file-start",
			id: "s",
			timestamp: 0,
			payload: { transferId, fileName: "bad.bin", fileSize: 3, chunkSize: FILE_CHUNK_SIZE },
		});
		receiver.handleMessage(chunkMessage(transferId, 0, new Uint8Array([1, 2, 3])));
		receiver.handleMessage({
			type: "file-end",
			id: "e",
			timestamp: 0,
			payload: { transferId, checksum: "wrong" },
		});
		await receiver.dispose();

		const failed = events.find((e) => e.kind === "failed");
		expect(failed?.kind).toBe("failed");
		if (failed?.kind !== "failed") throw new Error("unreachable");
		expect(failed.reason).toBe("checksum mismatch");
		expect(events.some((e) => e.kind === "completed")).toBe(false);
		const dir = await import("node:fs/promises").then((fs) => fs.readdir(scratchDir));
		expect(dir).toEqual([]);
	});

	it("fails on an out-of-order chunk index", async () => {
		const { events, sink } = collectEvents();
		const receiver = new FileReceiver({ downloadDir: scratchDir, onEvent: sink });
		const transferId = crypto.randomUUID();

		receiver.handleMessage({
			type: "file-start",
			id: "s",
			timestamp: 0,
			payload: { transferId, fileName: "ooo.bin", fileSize: 6, chunkSize: FILE_CHUNK_SIZE },
		});
		receiver.handleMessage(chunkMessage(transferId, 1, new Uint8Array([1, 2, 3])));
		await receiver.dispose();

		const failed = events.find((e) => e.kind === "failed");
		expect(failed?.kind).toBe("failed");
		if (failed?.kind !== "failed") throw new Error("unreachable");
		expect(failed.reason).toContain("out-of-order");
	});

	it("cleans up on a peer-sent file-abort", async () => {
		const { events, sink } = collectEvents();
		const receiver = new FileReceiver({ downloadDir: scratchDir, onEvent: sink });
		const transferId = crypto.randomUUID();

		receiver.handleMessage({
			type: "file-start",
			id: "s",
			timestamp: 0,
			payload: { transferId, fileName: "abort.bin", fileSize: 3, chunkSize: FILE_CHUNK_SIZE },
		});
		receiver.handleMessage({
			type: "file-abort",
			id: "a",
			timestamp: 0,
			payload: { transferId, reason: "sender disk died" },
		});
		await receiver.dispose();

		const failed = events.find((e) => e.kind === "failed");
		expect(failed?.kind).toBe("failed");
		if (failed?.kind !== "failed") throw new Error("unreachable");
		expect(failed.reason).toBe("aborted by peer: sender disk died");
		const dir = await import("node:fs/promises").then((fs) => fs.readdir(scratchDir));
		expect(dir).toEqual([]);
	});

	it("dispose fails in-flight transfers and removes temp files", async () => {
		const { events, sink } = collectEvents();
		const receiver = new FileReceiver({ downloadDir: scratchDir, onEvent: sink });
		const transferId = crypto.randomUUID();

		receiver.handleMessage({
			type: "file-start",
			id: "s",
			timestamp: 0,
			payload: { transferId, fileName: "partial.bin", fileSize: 100, chunkSize: FILE_CHUNK_SIZE },
		});
		receiver.handleMessage(chunkMessage(transferId, 0, new Uint8Array([1, 2, 3])));
		await receiver.dispose();

		const failed = events.find((e) => e.kind === "failed");
		expect(failed?.kind).toBe("failed");
		if (failed?.kind !== "failed") throw new Error("unreachable");
		expect(failed.reason).toBe("connection lost");
		const dir = await import("node:fs/promises").then((fs) => fs.readdir(scratchDir));
		expect(dir).toEqual([]);
	});

	it("completes a zero-byte transfer", async () => {
		const { events, sink } = collectEvents();
		const receiver = new FileReceiver({ downloadDir: scratchDir, onEvent: sink });
		const transferId = crypto.randomUUID();

		receiver.handleMessage({
			type: "file-start",
			id: "s",
			timestamp: 0,
			payload: { transferId, fileName: "empty.bin", fileSize: 0, chunkSize: FILE_CHUNK_SIZE },
		});
		receiver.handleMessage({
			type: "file-end",
			id: "e",
			timestamp: 0,
			payload: { transferId, checksum: sha256Hex(new Uint8Array(0)) },
		});
		await receiver.dispose();

		const completed = events.find((e) => e.kind === "completed");
		if (completed?.kind !== "completed") throw new Error("unreachable");
		expect((await readFile(completed.path)).length).toBe(0);
	});

	it("drops chunks for unknown transfers", async () => {
		const { events, sink } = collectEvents();
		const receiver = new FileReceiver({ downloadDir: scratchDir, onEvent: sink });
		receiver.handleMessage(chunkMessage(crypto.randomUUID(), 0, new Uint8Array([1])));
		await receiver.dispose();
		expect(events.length).toBe(0);
	});
});

describe("uniqueDownloadPath", () => {
	it("returns the plain name when free and suffixed names on collision", async () => {
		await mkdir(join(scratchDir, "dl"), { recursive: true });
		const dir = join(scratchDir, "dl");
		expect(await uniqueDownloadPath(dir, "a.md")).toBe(join(dir, "a.md"));
		await writeFile(join(dir, "a.md"), "x");
		expect(await uniqueDownloadPath(dir, "a.md")).toBe(join(dir, "a (1).md"));
		await writeFile(join(dir, "a (1).md"), "x");
		expect(await uniqueDownloadPath(dir, "a.md")).toBe(join(dir, "a (2).md"));
	});
});

describe("frame codec used by the transfer engine", () => {
	it("encodeFileChunkFrame/decodeFileChunkFrame agree with the sender loop", () => {
		const id = "01234567-89ab-cdef-0123-456789abcdef";
		const frame = encodeFileChunkFrame(id, 5, new Uint8Array([7, 8]));
		const decoded = decodeFileChunkFrame(frame);
		expect(decoded).toMatchObject({ transferId: id, index: 5 });
	});
});

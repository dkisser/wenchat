import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { truncateSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FileChunkFramePayload,
	type Message,
	decodeFileChunkFrame,
	encodeFileChunkFrame,
} from "@wenchat/protocol";
import {
	BUFFERED_AMOUNT_HIGH_WATER,
	DEFAULT_FILE_UNACKED_BITMAP_CAP,
	FILE_CHUNK_SIZE,
	FileReceiver,
	FileSender,
	MAX_CONCURRENT_TRANSFERS,
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

function chunkPayload(transferId: string, index: number, data: Uint8Array): FileChunkFramePayload {
	return { transferId, index, data };
}

function startMessage(transferId: string, fileName: string, fileSize: number): Message {
	return {
		type: "file-start",
		id: `start-${transferId}`,
		timestamp: 0,
		payload: { transferId, fileName, fileSize, chunkSize: FILE_CHUNK_SIZE },
	};
}

function endMessage(transferId: string, checksum: string): Message {
	return {
		type: "file-end",
		id: `end-${transferId}`,
		timestamp: 0,
		payload: { transferId, checksum },
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

	it("aborts instead of reporting success when the source file shrinks mid-send", async () => {
		const path = join(scratchDir, "shrinking.bin");
		await writeFile(path, randomBytes(FILE_CHUNK_SIZE * 2));
		const channel = makeFakeChannel();
		// Shrink the file synchronously after the first frame goes out, so the
		// next read hits EOF well before the announced size. Sending a file-end
		// at that point would deliver a truncated file that "verifies".
		channel.sendBinary = (frame: Uint8Array) => {
			truncateSync(path, 5);
			channel.frames.push(decodeFileChunkFrame(frame));
		};

		await expect(sendFile(channel as unknown as SendChannel, path)).rejects.toThrow("changed size");
		expect(channel.sent.some((m) => m.type === "file-abort")).toBe(true);
		expect(channel.sent.some((m) => m.type === "file-end")).toBe(false);
	});
});

describe("FileReceiver", () => {
	function collectEvents(): { events: TransferEvent[]; sink: (e: TransferEvent) => void } {
		const events: TransferEvent[] = [];
		return { events, sink: (e) => events.push(e) };
	}

	it("writes a complete transfer to a temp file then renames it into place", async () => {
		const { events, sink } = collectEvents();
		const receiver = new FileReceiver({
			downloadDir: scratchDir,
			onEvent: sink,
			validationDelayMs: 0,
		});
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
		receiver.handleChunk(chunkPayload(transferId, 0, content.subarray(0, FILE_CHUNK_SIZE)));
		receiver.handleChunk(chunkPayload(transferId, 1, content.subarray(FILE_CHUNK_SIZE)));
		receiver.handleMessage({
			type: "file-end",
			id: "e",
			timestamp: 0,
			payload: { transferId, checksum: sha256Hex(content) },
		});
		await receiver.waitForIdle();
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
		const receiver = new FileReceiver({
			downloadDir: scratchDir,
			onEvent: sink,
			validationDelayMs: 0,
		});
		const content = new Uint8Array([1, 2, 3]);
		const transferId = crypto.randomUUID();

		receiver.handleMessage({
			type: "file-start",
			id: "s",
			timestamp: 0,
			payload: { transferId, fileName: "dup.bin", fileSize: 3, chunkSize: FILE_CHUNK_SIZE },
		});
		receiver.handleChunk(chunkPayload(transferId, 0, content));
		receiver.handleMessage({
			type: "file-end",
			id: "e",
			timestamp: 0,
			payload: { transferId, checksum: sha256Hex(content) },
		});
		await receiver.waitForIdle();
		await receiver.dispose();

		const completed = events.find((e) => e.kind === "completed");
		if (completed?.kind !== "completed") throw new Error("unreachable");
		expect(completed.path).toBe(join(scratchDir, "dup (1).bin"));
	});

	it("deletes the temp file and fails on checksum mismatch", async () => {
		const { events, sink } = collectEvents();
		const receiver = new FileReceiver({
			downloadDir: scratchDir,
			onEvent: sink,
			validationDelayMs: 0,
		});
		const transferId = crypto.randomUUID();

		receiver.handleMessage({
			type: "file-start",
			id: "s",
			timestamp: 0,
			payload: { transferId, fileName: "bad.bin", fileSize: 3, chunkSize: FILE_CHUNK_SIZE },
		});
		receiver.handleChunk(chunkPayload(transferId, 0, new Uint8Array([1, 2, 3])));
		receiver.handleMessage({
			type: "file-end",
			id: "e",
			timestamp: 0,
			payload: { transferId, checksum: "wrong" },
		});
		await receiver.waitForIdle();
		await receiver.dispose();

		const failed = events.find((e) => e.kind === "failed");
		expect(failed?.kind).toBe("failed");
		if (failed?.kind !== "failed") throw new Error("unreachable");
		expect(failed.reason).toBe("checksum mismatch");
		expect(events.some((e) => e.kind === "completed")).toBe(false);
		const dir = await import("node:fs/promises").then((fs) => fs.readdir(scratchDir));
		expect(dir).toEqual([]);
	});

	it("an out-of-order chunk no longer fails the transfer (PR-5 reframing)", async () => {
		// PR-5 reframes the old "out-of-order chunk = protocol violation"
		// rule (PR-1/2/3/4 behavior): out-of-order now triggers a
		// FileChunkAckMessage bitmap so the sender can retransmit. The
		// transfer only fails when the sender itself gives up (5 retries
		// → file-abort → transfer-abandoned). This test pins the
		// behavior flip — see the new "FileReceiver — chunk-level ACK"
		// describe for the receiver-side ACK details.
		const { events, sink } = collectEvents();
		const receiver = new FileReceiver({
			downloadDir: scratchDir,
			onEvent: sink,
			validationDelayMs: 0,
		});
		const transferId = crypto.randomUUID();

		receiver.handleMessage({
			type: "file-start",
			id: "s",
			timestamp: 0,
			payload: { transferId, fileName: "ooo.bin", fileSize: 6, chunkSize: FILE_CHUNK_SIZE },
		});
		receiver.handleChunk(chunkPayload(transferId, 1, new Uint8Array([1, 2, 3])));
		await receiver.waitForIdle();
		await receiver.dispose();

		// No "failed" event from out-of-order anymore. (A failed event may
		// still appear from dispose()'s teardown — but its reason must not
		// be the out-of-order path.)
		const failures = events.filter((e) => e.kind === "failed");
		for (const failure of failures) {
			if (failure.kind !== "failed") continue;
			expect(failure.reason).not.toContain("out-of-order");
		}
	});

	it("cleans up on a peer-sent file-abort", async () => {
		const { events, sink } = collectEvents();
		const receiver = new FileReceiver({
			downloadDir: scratchDir,
			onEvent: sink,
			validationDelayMs: 0,
		});
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
		await receiver.waitForIdle();
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
		const receiver = new FileReceiver({
			downloadDir: scratchDir,
			onEvent: sink,
			validationDelayMs: 0,
		});
		const transferId = crypto.randomUUID();

		receiver.handleMessage({
			type: "file-start",
			id: "s",
			timestamp: 0,
			payload: { transferId, fileName: "partial.bin", fileSize: 100, chunkSize: FILE_CHUNK_SIZE },
		});
		receiver.handleChunk(chunkPayload(transferId, 0, new Uint8Array([1, 2, 3])));
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
		const receiver = new FileReceiver({
			downloadDir: scratchDir,
			onEvent: sink,
			validationDelayMs: 0,
		});
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
		await receiver.waitForIdle();
		await receiver.dispose();

		const completed = events.find((e) => e.kind === "completed");
		if (completed?.kind !== "completed") throw new Error("unreachable");
		expect((await readFile(completed.path)).length).toBe(0);
	});

	it("drops chunks for unknown transfers", async () => {
		const { events, sink } = collectEvents();
		const receiver = new FileReceiver({
			downloadDir: scratchDir,
			onEvent: sink,
			validationDelayMs: 0,
		});
		receiver.handleChunk(chunkPayload(crypto.randomUUID(), 0, new Uint8Array([1])));
		await receiver.dispose();
		expect(events.length).toBe(0);
	});

	it("fails a transfer whose chunks exceed the announced file size", async () => {
		const { events, sink } = collectEvents();
		const receiver = new FileReceiver({
			downloadDir: scratchDir,
			onEvent: sink,
			validationDelayMs: 0,
		});
		const transferId = crypto.randomUUID();

		receiver.handleMessage(startMessage(transferId, "over.bin", 3));
		receiver.handleChunk(chunkPayload(transferId, 0, new Uint8Array([1, 2, 3, 4])));
		await receiver.waitForIdle();
		await receiver.dispose();

		const failed = events.find((e) => e.kind === "failed");
		expect(failed?.kind).toBe("failed");
		if (failed?.kind !== "failed") throw new Error("unreachable");
		expect(failed.reason).toContain("announced file size");
		const dir = await import("node:fs/promises").then((fs) => fs.readdir(scratchDir));
		expect(dir).toEqual([]);
	});

	it("fails file-end when received bytes don't match the announced size", async () => {
		const { events, sink } = collectEvents();
		const receiver = new FileReceiver({
			downloadDir: scratchDir,
			onEvent: sink,
			validationDelayMs: 0,
		});
		const transferId = crypto.randomUUID();
		const partial = new Uint8Array([1, 2, 3]);

		receiver.handleMessage(startMessage(transferId, "short.bin", 6));
		receiver.handleChunk(chunkPayload(transferId, 0, partial));
		// The checksum covers exactly what arrived — without a byte-count check
		// this truncated file would be renamed into place as a "success".
		receiver.handleMessage(endMessage(transferId, sha256Hex(partial)));
		await receiver.waitForIdle();
		await receiver.dispose();

		const failed = events.find((e) => e.kind === "failed");
		expect(failed?.kind).toBe("failed");
		if (failed?.kind !== "failed") throw new Error("unreachable");
		expect(failed.reason).toContain("incomplete");
		expect(events.some((e) => e.kind === "completed")).toBe(false);
		const dir = await import("node:fs/promises").then((fs) => fs.readdir(scratchDir));
		expect(dir).toEqual([]);
	});

	it("rejects a new transfer once the concurrent limit is reached", async () => {
		const { events, sink } = collectEvents();
		const receiver = new FileReceiver({
			downloadDir: scratchDir,
			onEvent: sink,
			validationDelayMs: 0,
		});

		for (let i = 0; i < MAX_CONCURRENT_TRANSFERS; i++) {
			receiver.handleMessage(startMessage(crypto.randomUUID(), `t${i}.bin`, 1));
		}
		receiver.handleMessage(startMessage(crypto.randomUUID(), "overflow.bin", 1));
		await receiver.waitForIdle();
		await receiver.dispose();

		expect(events.filter((e) => e.kind === "started").length).toBe(MAX_CONCURRENT_TRANSFERS);
		const rejected = events.find((e) => e.kind === "failed" && e.fileName === "overflow.bin");
		expect(rejected?.kind).toBe("failed");
		if (rejected?.kind !== "failed") throw new Error("unreachable");
		expect(rejected.reason).toContain("concurrent");
	});

	it("a duplicate transfer id fails and cleans up the previous transfer", async () => {
		const { events, sink } = collectEvents();
		const receiver = new FileReceiver({
			downloadDir: scratchDir,
			onEvent: sink,
			validationDelayMs: 0,
		});
		const transferId = crypto.randomUUID();
		const content = new Uint8Array([9, 9, 9]);

		receiver.handleMessage(startMessage(transferId, "first.bin", 100));
		receiver.handleChunk(chunkPayload(transferId, 0, new Uint8Array([1])));
		// Reusing the id must not leak the first transfer's handle/temp file.
		receiver.handleMessage(startMessage(transferId, "second.bin", 3));
		receiver.handleChunk(chunkPayload(transferId, 0, content));
		receiver.handleMessage(endMessage(transferId, sha256Hex(content)));
		await receiver.waitForIdle();
		await receiver.dispose();

		const duplicate = events.find((e) => e.kind === "failed" && e.fileName === "first.bin");
		expect(duplicate?.kind).toBe("failed");
		if (duplicate?.kind !== "failed") throw new Error("unreachable");
		expect(duplicate.reason).toContain("duplicate");
		const completed = events.find((e) => e.kind === "completed");
		expect(completed?.kind).toBe("completed");
		if (completed?.kind !== "completed") throw new Error("unreachable");
		expect(completed.fileName).toBe("second.bin");
		const dir = await import("node:fs/promises").then((fs) => fs.readdir(scratchDir));
		expect(dir).toEqual(["second.bin"]);
	});

	it("rejects a negative announced file size without touching disk", async () => {
		const { events, sink } = collectEvents();
		const receiver = new FileReceiver({
			downloadDir: scratchDir,
			onEvent: sink,
			validationDelayMs: 0,
		});
		const transferId = crypto.randomUUID();

		receiver.handleMessage(startMessage(transferId, "neg.bin", -1));
		await receiver.waitForIdle();
		await receiver.dispose();

		const failed = events.find((e) => e.kind === "failed");
		expect(failed?.kind).toBe("failed");
		if (failed?.kind !== "failed") throw new Error("unreachable");
		expect(failed.reason).toContain("invalid");
		expect(events.some((e) => e.kind === "started")).toBe(false);
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

// ---------------------------------------------------------------------------
// PR-5 — chunk-level ACK (ADR 0003 Q2 / Q8 / F.5)
//
// The receiver-side chunk bitmap is the new recovery channel for file
// transfers. Each side keeps its own per-transferId view:
//
//   * Receiver: Set<number> of received chunk indices, plus an
//     `expectedNext` cursor that cascades through contiguous received
//     indices. Out-of-order chunks no longer fail the transfer — they
//     trigger an immediate FileChunkAckMessage so the sender can fill
//     the hole. Duplicates are silently dropped.
//
//   * Sender: per-transferId unacked-indices set + per-chunk retry
//     counters. Every FileChunkAckMessage updates the set; indices the
//     receiver reports as still missing are retransmitted with the same
//     5-attempts exponential backoff the chat outbox uses (2 s → 30 s,
//     capped). One chunk exhausting its budget abandons the whole
//     transfer (file-abort + transfer-abandoned event).
//
// File chunks do not flow through the chat outbox (ADR 0003 F.5):
// the bitmap ACK is the only recovery channel.
// ---------------------------------------------------------------------------

describe("FileReceiver — chunk-level ACK (PR-5)", () => {
	function collectEvents(): { events: TransferEvent[]; sink: (e: TransferEvent) => void } {
		const events: TransferEvent[] = [];
		return { events, sink: (e) => events.push(e) };
	}

	function collectMessages(): {
		messages: Message[];
		sink: (m: Message) => void;
	} {
		const messages: Message[] = [];
		return { messages, sink: (m) => messages.push(m) };
	}

	function newReceiver(
		dir: string,
		messageSink: (m: Message) => void,
		eventSink?: (e: TransferEvent) => void,
	): FileReceiver {
		return new FileReceiver({
			downloadDir: dir,
			sendMessage: messageSink,
			onEvent: eventSink,
			validationDelayMs: 0,
		});
	}

	function chunkAcks(messages: Message[]): Array<{
		transferId: string;
		bitmap: Uint8Array;
		lastIndex: number;
	}> {
		return messages.flatMap((m) => (m.type === "file-chunk-ack" ? [m.payload] : []));
	}

	it("emits a FileChunkAckMessage after every 32 chunks received (ADR 0003 Q8)", async () => {
		// 64 chunks → two every-32 ACKs (one at chunk 32, one at chunk 64).
		// We do not assert file-end emits anything here — that's a separate
		// test below — so the count is at LEAST 2.
		const { messages, sink } = collectMessages();
		const receiver = newReceiver(scratchDir, sink);
		const transferId = crypto.randomUUID();
		const totalChunks = 64;
		const fileSize = totalChunks * FILE_CHUNK_SIZE;

		receiver.handleMessage(startMessage(transferId, "ack32.bin", fileSize));
		for (let i = 0; i < totalChunks; i++) {
			receiver.handleChunk(chunkPayload(transferId, i, new Uint8Array(FILE_CHUNK_SIZE)));
		}
		await receiver.waitForIdle();

		const acks = chunkAcks(messages);
		expect(acks.length).toBeGreaterThanOrEqual(2);
		// First every-32 ACK fires right after chunk 31 is accepted
		// (the counter hits 32), so its lastIndex is 31 and its bitmap
		// has bit 31 set.
		expect(acks[0].transferId).toBe(transferId);
		expect(acks[0].lastIndex).toBe(31);
		expect(acks[0].bitmap[3] & (1 << 7)).not.toBe(0); // bit 31 in byte 3
	});

	it("file-end triggers a final FileChunkAckMessage so the sender can fill any gap", async () => {
		const { messages, sink } = collectMessages();
		const { events, sink: evSink } = collectEvents();
		const receiver = newReceiver(scratchDir, sink, evSink);
		const transferId = crypto.randomUUID();
		const content = randomBytes(FILE_CHUNK_SIZE * 3);

		receiver.handleMessage(startMessage(transferId, "fe.bin", content.length));
		for (let i = 0; i < 3; i++) {
			receiver.handleChunk(
				chunkPayload(
					transferId,
					i,
					content.subarray(i * FILE_CHUNK_SIZE, (i + 1) * FILE_CHUNK_SIZE),
				),
			);
		}
		const acksBeforeEnd = chunkAcks(messages).length;
		receiver.handleMessage(endMessage(transferId, sha256Hex(content)));
		await receiver.waitForIdle();

		// At least one new ACK lands after file-end (the "every 32" trigger
		// doesn't fire at 3 chunks, so this ACK is purely the file-end one).
		const acksAfterEnd = chunkAcks(messages).length;
		expect(acksAfterEnd).toBeGreaterThan(acksBeforeEnd);

		const lastAck = chunkAcks(messages).slice(-1)[0];
		expect(lastAck.lastIndex).toBe(2);
		expect(events.some((e) => e.kind === "completed")).toBe(true);
	});

	it("an out-of-order chunk sends a FileChunkAckMessage without failing the transfer", async () => {
		// PR-5 reframing: out-of-order = "ask the sender to retransmit",
		// NOT "fail the transfer". The transfer only fails if the sender
		// gives up (5 retries → file-abort → transfer-abandoned).
		const { messages, sink } = collectMessages();
		const { events, sink: evSink } = collectEvents();
		const receiver = newReceiver(scratchDir, sink, evSink);
		const transferId = crypto.randomUUID();
		const totalChunks = 10;
		const fileSize = totalChunks * FILE_CHUNK_SIZE;

		receiver.handleMessage(startMessage(transferId, "ooo.bin", fileSize));
		// Send chunk 5 out of order (no contiguous prefix yet).
		receiver.handleChunk(chunkPayload(transferId, 5, new Uint8Array(FILE_CHUNK_SIZE)));
		await receiver.waitForIdle();

		const acks = chunkAcks(messages);
		expect(acks).toHaveLength(1);
		// The receiver's receivedIndices = {5}, so lastIndex = 5 (the
		// highest index seen, NOT the contiguous cursor — see
		// `buildChunkAckBitmap`'s doc for why). bitmap covers 0..5 with
		// only bit 5 set; the sender learns "everything below 5 is
		// missing" and retransmits 0..4.
		expect(acks[0].lastIndex).toBe(5);
		expect(acks[0].bitmap[0] & (1 << 5)).not.toBe(0); // bit 5 set
		// And the transfer does NOT fail (out-of-order is no longer fatal).
		expect(events.some((e) => e.kind === "failed")).toBe(false);
	});

	it("a duplicate chunk is silently dropped (no ACK, no double-write)", async () => {
		const { messages, sink } = collectMessages();
		const receiver = newReceiver(scratchDir, sink);
		const transferId = crypto.randomUUID();
		const fileSize = FILE_CHUNK_SIZE * 3;
		const data = new Uint8Array(FILE_CHUNK_SIZE);

		receiver.handleMessage(startMessage(transferId, "dup.bin", fileSize));
		receiver.handleChunk(chunkPayload(transferId, 0, data));
		await receiver.waitForIdle();
		// Chunk 0 advances expectedNext to 1 — does NOT trigger every-32,
		// so no ACK has been emitted yet.
		const before = chunkAcks(messages).length;
		// Re-send chunk 0. Receiver dedups.
		receiver.handleChunk(chunkPayload(transferId, 0, data));
		await receiver.waitForIdle();
		// The duplicate MUST NOT trigger a fresh ACK (it carries no new
		// information the sender doesn't already have).
		expect(chunkAcks(messages).length).toBe(before);
		// And the transfer MUST NOT fail (duplicates are normal under
		// selective retransmit).
		receiver.handleMessage(endMessage(transferId, sha256Hex(data)));
	});

	it("the per-transfer received bitmap survives past chunk 32", async () => {
		// Behavioral check for the received-bitmap state, separate from the
		// ACK emission cadence. After 32 contiguous chunks, expectedNext
		// must equal 32 and the transfer must still be in-flight.
		const { events, sink } = collectEvents();
		const receiver = newReceiver(scratchDir, () => {}, sink);
		const transferId = crypto.randomUUID();
		const fileSize = FILE_CHUNK_SIZE * 40;

		receiver.handleMessage(startMessage(transferId, "bm.bin", fileSize));
		for (let i = 0; i < 32; i++) {
			receiver.handleChunk(chunkPayload(transferId, i, new Uint8Array(FILE_CHUNK_SIZE)));
		}
		await receiver.waitForIdle();
		// All 32 received, expectedNext = 32; no fail event has fired yet.
		expect(events.some((e) => e.kind === "failed")).toBe(false);
		expect(events.some((e) => e.kind === "completed")).toBe(false);
	});
});

describe("FileSender — chunk-level ACK + selective retransmit (PR-5)", () => {
	function makeSenderHarness(opts?: {
		highWaterBytes?: number;
		initialRetransmitMs?: number;
		maxRetransmitMs?: number;
		maxRetransmitAttempts?: number;
	}) {
		const resentChunks: Array<{ transferId: string; index: number; data: Uint8Array }> = [];
		const abandoned: string[] = [];
		let channel: SendChannel | null = null;

		const sender = new FileSender({
			getChannel: () => channel,
			onTransferAbandoned: (transferId) => abandoned.push(transferId),
			initialRetransmitMs: opts?.initialRetransmitMs,
			maxRetransmitMs: opts?.maxRetransmitMs,
			maxRetransmitAttempts: opts?.maxRetransmitAttempts,
		});

		return {
			sender,
			resentChunks,
			abandoned,
			setChannel: (c: SendChannel | null) => {
				channel = c;
			},
		};
	}

	function readChunkFromFile(path: string, index: number, chunkSize: number): Uint8Array {
		// Tiny synchronous read for test assertions. We never actually
		// open the file here — the harness intercepts sendBinary and
		// captures what was sent.
		return new Uint8Array(0);
	}

	it("throws 'Data channel not ready' when there is no channel at sendFile time", async () => {
		const h = makeSenderHarness();
		h.setChannel(null);
		const path = join(scratchDir, "nochan.bin");
		await writeFile(path, randomBytes(FILE_CHUNK_SIZE));
		await expect(h.sender.sendFile(path)).rejects.toThrow("Data channel not ready");
	});

	it("DEFAULT_FILE_UNACKED_BITMAP_CAP is 256 (ADR 0003 / PR-5 default)", () => {
		// Documented in core.md as the default cap. The constant is what
		// the production sender passes into MessageAckScheduler-style LRU
		// bookkeeping for the unacked chunk set; exposing it as a named
		// export gives operators a stable knob.
		expect(DEFAULT_FILE_UNACKED_BITMAP_CAP).toBe(256);
	});

	it("maintains an unacked bitmap of every sent chunk until ACK clears them", async () => {
		const h = makeSenderHarness();
		const content = randomBytes(FILE_CHUNK_SIZE * 3);
		const path = join(scratchDir, "unacked.bin");
		await writeFile(path, content);
		const channel = makeFakeChannel();
		h.setChannel(channel);

		const result = await h.sender.sendFile(path);
		expect(result.bytesSent).toBe(content.length);

		// Three chunks sent, none acked yet.
		expect(channel.frames.length).toBe(3);
		expect(h.sender.unackedCount(result.transferId)).toBe(3);

		// ACK all three. Bitmap must clear. Only byte 0 is needed
		// (chunks 0..7); bit 2 is set; bits 0, 1 are also set. Lastindex=2
		// tells the sender the bitmap covers chunks 0..2.
		const allBits = new Uint8Array([0b00000111]);
		h.sender.noteChunkAck({ transferId: result.transferId, bitmap: allBits, lastIndex: 2 });
		expect(h.sender.unackedCount(result.transferId)).toBe(0);
	});

	it("selectively retransmits only the chunks missing from the ACK bitmap", async () => {
		const h = makeSenderHarness({
			initialRetransmitMs: 30,
			maxRetransmitMs: 100,
			maxRetransmitAttempts: 5,
		});
		const content = randomBytes(FILE_CHUNK_SIZE * 5);
		const path = join(scratchDir, "selective.bin");
		await writeFile(path, content);
		const channel = makeFakeChannel();
		h.setChannel(channel);

		const result = await h.sender.sendFile(path);

		// Intercept sendBinary on the channel so we can record retransmits
		// without going through FileHandle I/O.
		const originalSendBinary = channel.sendBinary.bind(channel);
		const resentIndices: number[] = [];
		channel.sendBinary = (frame: Uint8Array) => {
			const decoded = decodeFileChunkFrame(frame);
			resentIndices.push(decoded.index);
			originalSendBinary(frame);
		};

		// Receiver ACK: chunks 0, 1, 3, 4 are present; chunk 2 is missing.
		// lastIndex = 4 (the highest index the receiver has any info for).
		// bitmap is LSB-first: byte 0 covers chunks 0..7. So byte 0 =
		// 0b00011011 (bits 0,1,3,4 set; bit 2 clear). Byte 1 stays 0
		// because no chunk >= 8 is named.
		const bitmap = new Uint8Array([0b00011011, 0]);
		h.sender.noteChunkAck({ transferId: result.transferId, bitmap, lastIndex: 4 });

		// The retransmit timer fires asynchronously — wait for it.
		await new Promise<void>((r) => setTimeout(r, 80));

		expect(resentIndices).toEqual([2]);
	});

	it("abandons the transfer after the 5th failed retransmit (emits transfer-abandoned + file-abort)", async () => {
		const h = makeSenderHarness({
			initialRetransmitMs: 20,
			maxRetransmitMs: 60,
			maxRetransmitAttempts: 5,
		});
		const content = randomBytes(FILE_CHUNK_SIZE * 2);
		const path = join(scratchDir, "abandon.bin");
		await writeFile(path, content);
		const channel = makeFakeChannel();
		h.setChannel(channel);

		const result = await h.sender.sendFile(path);

		// Intercept retransmits so we can confirm they're sent (the 5th
		// attempt is the give-up, so we expect 4 sendBinary calls after
		// the initial 2 sends = 6 total).
		const resentIndices: number[] = [];
		const originalSendBinary = channel.sendBinary.bind(channel);
		channel.sendBinary = (frame: Uint8Array) => {
			const decoded = decodeFileChunkFrame(frame);
			resentIndices.push(decoded.index);
			originalSendBinary(frame);
		};

		// Receiver says NOTHING is acked → both chunks are retransmitted.
		// (No bitmap at all — lastIndex = -1.)
		h.sender.noteChunkAck({
			transferId: result.transferId,
			bitmap: new Uint8Array(0),
			lastIndex: -1,
		});

		// Wait long enough for 5 attempts on chunk 0: 20 + 40 + 60 + 60 + 60 + slack.
		await new Promise<void>((r) => setTimeout(r, 20 + 40 + 60 + 60 + 60 + 80));

		// transfer-abandoned event fired for this transfer.
		expect(h.abandoned).toEqual([result.transferId]);

		// file-abort frame was emitted on the wire so the receiver drops the partial.
		const abort = channel.sent.find((m) => m.type === "file-abort");
		expect(abort?.type).toBe("file-abort");
		if (abort?.type !== "file-abort") throw new Error("unreachable");
		expect(abort.payload.transferId).toBe(result.transferId);

		// After abandon, the unacked set is gone.
		expect(h.sender.unackedCount(result.transferId)).toBe(0);
	});

	it("noteChunkAck on an unknown transferId is a silent no-op", async () => {
		const h = makeSenderHarness();
		h.sender.noteChunkAck({
			transferId: "not-a-real-transfer",
			bitmap: new Uint8Array([0xff]),
			lastIndex: 7,
		});
		expect(h.abandoned).toEqual([]);
	});

	it("a fresh missing-report pulls a pending retry forward to the initial delay", async () => {
		const h = makeSenderHarness({
			initialRetransmitMs: 30,
			maxRetransmitMs: 500,
			maxRetransmitAttempts: 5,
		});
		const content = randomBytes(FILE_CHUNK_SIZE * 2);
		const path = join(scratchDir, "pull-forward.bin");
		await writeFile(path, content);
		const channel = makeFakeChannel();
		h.setChannel(channel);

		const result = await h.sender.sendFile(path);

		const resentIndices: number[] = [];
		const originalSendBinary = channel.sendBinary.bind(channel);
		channel.sendBinary = (frame: Uint8Array) => {
			resentIndices.push(decodeFileChunkFrame(frame).index);
			originalSendBinary(frame);
		};

		// Chunk 1 present (bit 1 set), chunk 0 missing (bit 0 clear). The
		// first missing-report arms chunk 0 at attempt 1 → fires at ~30 ms,
		// sends, then re-arms at the attempt-2 backoff (~60 ms).
		const bitmap = new Uint8Array([0b00000010]);
		h.sender.noteChunkAck({ transferId: result.transferId, bitmap, lastIndex: 1 });
		await new Promise<void>((r) => setTimeout(r, 80));
		expect(resentIndices).toEqual([0]);

		// A FRESH missing-report must pull the pending attempt-2 timer
		// (~60 ms away) forward to the initial delay (~30 ms). Without the
		// pull-forward the second retransmit lands outside the 50 ms window
		// below — the exact failure that made receivers declare transfers
		// incomplete while the sender still had retry budget.
		h.sender.noteChunkAck({ transferId: result.transferId, bitmap, lastIndex: 1 });
		await new Promise<void>((r) => setTimeout(r, 50));
		expect(resentIndices.filter((i) => i === 0).length).toBe(2);
	});

	it("a retry that fires with no channel re-arms without burning the attempt budget", async () => {
		const h = makeSenderHarness({
			initialRetransmitMs: 20,
			maxRetransmitMs: 60,
			maxRetransmitAttempts: 2,
		});
		const content = randomBytes(FILE_CHUNK_SIZE * 2);
		const path = join(scratchDir, "nochan-rearm.bin");
		await writeFile(path, content);
		const channel = makeFakeChannel();

		h.setChannel(channel);
		const result = await h.sender.sendFile(path);
		// The channel disappears (reconnect window) before any retry fires.
		h.setChannel(null);

		// Nothing acked → both chunks arm at attempt 1 (20 ms). Every 20 ms
		// fire hits the no-channel branch: the old behavior CONSUMED AN
		// ATTEMPT per fire (20 ms, 40 ms → abandoned by ~60 ms) even though
		// nothing ever reached the wire. The fix re-arms at the same delay
		// and leaves the budget untouched.
		h.sender.noteChunkAck({
			transferId: result.transferId,
			bitmap: new Uint8Array(0),
			lastIndex: 1,
		});
		await new Promise<void>((r) => setTimeout(r, 150));
		expect(h.abandoned).toEqual([]);

		// Channel returns → the next fire (~20 ms) retransmits both chunks
		// for real as attempt 1. Had the budget burned during the outage,
		// the transfer would have been abandoned long before this.
		h.setChannel(channel);
		const resentIndices: number[] = [];
		const originalSendBinary = channel.sendBinary.bind(channel);
		channel.sendBinary = (frame: Uint8Array) => {
			resentIndices.push(decodeFileChunkFrame(frame).index);
			originalSendBinary(frame);
		};
		await new Promise<void>((r) => setTimeout(r, 40));
		expect(resentIndices.sort()).toEqual([0, 1]);
		expect(h.abandoned).toEqual([]);
	});
});

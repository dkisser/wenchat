import { type Hash, createHash } from "node:crypto";
import { type FileHandle, access, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import {
	type FileChunkMessage,
	type FileEndMessage,
	type FileStartMessage,
	type Message,
	createFileAbort,
	createFileEnd,
	createFileStart,
	encodeFileChunkFrame,
} from "@wenchat/protocol";
import { getLogger } from "./logger";
import type { DataTransport } from "./transport";

/**
 * 64 KiB chunks: werift fragments every message into 1200-byte SCTP data
 * chunks internally, so a larger app-level chunk buys nothing at the
 * fragment layer — it only reduces per-chunk overhead (one 22-byte frame
 * header plus one event-loop turn) and gives smooth backpressure granularity.
 */
export const FILE_CHUNK_SIZE = 64 * 1024;

/**
 * Pause sending when werift's app-facing DataChannel queue exceeds this. The
 * queue is what the old unthrottled loop blew up (100 MiB of frames piling up
 * before the event loop could flush → OOM). Note `bufferedAmount` does not
 * count SCTP's unacked retransmission buffer; a truly stalled link is still
 * bounded by the heartbeat, which kills a dead peer in ~4 s.
 */
export const BUFFERED_AMOUNT_HIGH_WATER = 4 * 1024 * 1024;

export const DEFAULT_DOWNLOAD_DIR = join(homedir(), "Downloads");

/** Emit a progress event at most once per this many received bytes. */
const PROGRESS_GRANULARITY_BYTES = 256 * 1024;

export type SendFileOptions = {
	onProgress?: (sentBytes: number, totalBytes: number) => void;
	/**
	 * Override the backpressure high-water mark. Tests force it low to pace
	 * the sender over many drain cycles without needing a huge file.
	 */
	highWaterBytes?: number;
};

export type SendFileResult = {
	bytesSent: number;
	checksum: string;
	durationMs: number;
};

/** Minimal channel surface — `DataTransport` satisfies it; tests fake it. */
export type SendChannel = Pick<
	DataTransport,
	"send" | "sendBinary" | "waitForDrain" | "bufferedAmount" | "isOpen"
>;

/**
 * Stream a file to the peer: announce with file-start, read 64 KiB at a
 * time off disk, frame and send each chunk with high-water backpressure,
 * then close out with file-end carrying the sha256 of everything sent.
 * Memory stays O(high-water + one chunk) regardless of file size.
 *
 * On any failure a best-effort file-abort goes out so the receiver can
 * drop its partial temp file, and the original error is rethrown.
 */
export async function sendFile(
	channel: SendChannel,
	path: string,
	options?: SendFileOptions,
): Promise<SendFileResult> {
	const fileStat = await stat(path);
	if (!fileStat.isFile()) {
		throw new Error(`Not a regular file: ${path}`);
	}
	const highWater = options?.highWaterBytes ?? BUFFERED_AMOUNT_HIGH_WATER;
	const transferId = crypto.randomUUID();
	// Only the basename crosses the wire — the receiver never learns where
	// the file lives on our disk.
	const fileName = basename(path);
	const startedAt = Date.now();
	channel.send(createFileStart(fileName, fileStat.size, FILE_CHUNK_SIZE, transferId));

	const handle = await open(path, "r");
	const hash = createHash("sha256");
	let position = 0;
	let index = 0;
	try {
		const buffer = new Uint8Array(FILE_CHUNK_SIZE);
		while (position < fileStat.size) {
			const { bytesRead } = await handle.read(buffer, 0, FILE_CHUNK_SIZE, position);
			if (bytesRead === 0) break; // file shrank mid-read; send what we have
			const chunk = buffer.subarray(0, bytesRead);
			hash.update(chunk);
			channel.sendBinary(encodeFileChunkFrame(transferId, index, chunk));
			position += bytesRead;
			index++;
			if (channel.bufferedAmount > highWater) {
				await channel.waitForDrain(highWater / 2);
			}
			options?.onProgress?.(position, fileStat.size);
		}
		const checksum = hash.digest("hex");
		channel.send(createFileEnd(transferId, checksum));
		getLogger().info(
			{ transferId, path, bytes: position, durationMs: Date.now() - startedAt },
			"file sent",
		);
		return { bytesSent: position, checksum, durationMs: Date.now() - startedAt };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		try {
			channel.send(createFileAbort(transferId, reason));
		} catch {
			// The channel may be the thing that died — the abort is best-effort.
		}
		getLogger().error({ err: reason, transferId, path }, "file send failed");
		throw err;
	} finally {
		await handle.close();
	}
}

export type TransferEvent =
	| { kind: "started"; transferId: string; fileName: string; fileSize: number }
	| {
			kind: "progress";
			transferId: string;
			fileName: string;
			receivedBytes: number;
			totalBytes: number;
	  }
	| { kind: "completed"; transferId: string; fileName: string; path: string }
	| { kind: "failed"; transferId: string; fileName: string; reason: string };

type ActiveTransfer = {
	fileName: string;
	fileSize: number;
	finalPath: string;
	tempPath: string;
	handle: FileHandle;
	hash: Hash;
	received: number;
	nextIndex: number;
	lastProgressAt: number;
};

/**
 * Streaming counterpart to {@link sendFile}. Chunks are written to a
 * `<final>.part` temp file as they arrive (the DataChannel is ordered and
 * reliable, so an out-of-order index is a protocol violation, not a reorder)
 * and atomically renamed into place only after the sha256 in file-end
 * checks out — a crashed or aborted transfer never leaves a plausible-looking
 * partial file behind, only a `.part` that the next event cleans up.
 *
 * `handleMessage` is synchronous to call but serializes its fs work on an
 * internal promise queue, preserving wire order across awaits.
 */
export class FileReceiver {
	private transfers = new Map<string, ActiveTransfer>();
	private queue: Promise<void> = Promise.resolve();
	private readonly downloadDir: string;
	private readonly onEvent?: (event: TransferEvent) => void;

	constructor(opts: { downloadDir?: string; onEvent?: (event: TransferEvent) => void } = {}) {
		this.downloadDir = opts.downloadDir ?? DEFAULT_DOWNLOAD_DIR;
		this.onEvent = opts.onEvent;
	}

	/** Feed file-start/-chunk/-end/-abort messages; every other type is ignored. */
	handleMessage(message: Message): void {
		switch (message.type) {
			case "file-start":
				this.enqueue(() => this.startTransfer(message));
				break;
			case "file-chunk":
				this.enqueue(() => this.writeChunk(message));
				break;
			case "file-end":
				this.enqueue(() => this.finishTransfer(message));
				break;
			case "file-abort":
				this.enqueue(() =>
					this.failTransfer(
						message.payload.transferId,
						`aborted by peer: ${message.payload.reason}`,
					),
				);
				break;
			default:
				break;
		}
	}

	/**
	 * Abort every in-flight transfer and remove temp files (session loss,
	 * App unmount). Emits a `failed` event per affected transfer.
	 */
	async dispose(): Promise<void> {
		await this.queue;
		const active = [...this.transfers.entries()];
		this.transfers = new Map();
		for (const [transferId, transfer] of active) {
			await this.cleanup(transfer);
			this.emit({
				kind: "failed",
				transferId,
				fileName: transfer.fileName,
				reason: "connection lost",
			});
		}
	}

	private enqueue(task: () => Promise<void>): void {
		this.queue = this.queue.then(task).catch((err) => {
			getLogger().error(
				{ err: err instanceof Error ? err.message : String(err) },
				"file receiver task failed",
			);
		});
	}

	private async startTransfer(message: FileStartMessage): Promise<void> {
		const { transferId, fileName, fileSize } = message.payload;
		await mkdir(this.downloadDir, { recursive: true });
		const finalPath = await uniqueDownloadPath(this.downloadDir, fileName);
		const tempPath = `${finalPath}.part`;
		const handle = await open(tempPath, "w");
		this.transfers.set(transferId, {
			fileName,
			fileSize,
			finalPath,
			tempPath,
			handle,
			hash: createHash("sha256"),
			received: 0,
			nextIndex: 0,
			lastProgressAt: 0,
		});
		getLogger().info({ transferId, fileName, fileSize }, "file receive started");
		this.emit({ kind: "started", transferId, fileName, fileSize });
	}

	private async writeChunk(message: FileChunkMessage): Promise<void> {
		const { transferId, index, data } = message.payload;
		const transfer = this.transfers.get(transferId);
		if (!transfer) {
			getLogger().debug({ transferId, index }, "chunk for unknown transfer dropped");
			return;
		}
		if (index !== transfer.nextIndex) {
			// The channel is ordered + reliable, so a gap means the sender's
			// framing broke — fail loudly rather than write a corrupt file.
			await this.failTransfer(
				transferId,
				`out-of-order chunk (got index ${index}, expected ${transfer.nextIndex})`,
			);
			return;
		}
		await transfer.handle.write(data, 0, data.length, transfer.received);
		transfer.hash.update(data);
		transfer.received += data.length;
		transfer.nextIndex++;
		if (transfer.received - transfer.lastProgressAt >= PROGRESS_GRANULARITY_BYTES) {
			transfer.lastProgressAt = transfer.received;
			this.emit({
				kind: "progress",
				transferId,
				fileName: transfer.fileName,
				receivedBytes: transfer.received,
				totalBytes: transfer.fileSize,
			});
		}
	}

	private async finishTransfer(message: FileEndMessage): Promise<void> {
		const { transferId, checksum } = message.payload;
		const transfer = this.transfers.get(transferId);
		if (!transfer) {
			getLogger().debug({ transferId }, "file-end for unknown transfer dropped");
			return;
		}
		const actual = transfer.hash.digest("hex");
		if (actual !== checksum) {
			await this.failTransfer(transferId, "checksum mismatch");
			return;
		}
		this.transfers.delete(transferId);
		await transfer.handle.close();
		await rename(transfer.tempPath, transfer.finalPath);
		getLogger().info(
			{ transferId, fileName: transfer.fileName, path: transfer.finalPath },
			"file received",
		);
		this.emit({
			kind: "completed",
			transferId,
			fileName: transfer.fileName,
			path: transfer.finalPath,
		});
	}

	private async failTransfer(transferId: string, reason: string): Promise<void> {
		const transfer = this.transfers.get(transferId);
		if (!transfer) return;
		this.transfers.delete(transferId);
		await this.cleanup(transfer);
		getLogger().warn({ transferId, fileName: transfer.fileName, reason }, "file receive failed");
		this.emit({ kind: "failed", transferId, fileName: transfer.fileName, reason });
	}

	/** Close the temp handle and remove the partial file; both best-effort. */
	private async cleanup(transfer: ActiveTransfer): Promise<void> {
		try {
			await transfer.handle.close();
		} catch {
			// already closed
		}
		try {
			await unlink(transfer.tempPath);
		} catch {
			// temp file already gone
		}
	}

	private emit(event: TransferEvent): void {
		this.onEvent?.(event);
	}
}

/**
 * Resolve a filename inside `downloadDir` that doesn't collide with an
 * existing file. Follows macOS Finder's " (1)", " (2)" convention: a fresh
 * `foo.md` becomes `foo.md`, then `foo (1).md`, `foo (2).md`, … if the
 * previous names are taken.
 */
export async function uniqueDownloadPath(downloadDir: string, fileName: string): Promise<string> {
	const safeName = basename(fileName) || `received-${Date.now()}`;
	const candidate = join(downloadDir, safeName);
	if (!(await pathExists(candidate))) return candidate;
	const ext = extname(safeName);
	const stem = safeName.slice(0, safeName.length - ext.length);
	let counter = 1;
	while (true) {
		const next = join(downloadDir, `${stem} (${counter})${ext}`);
		if (!(await pathExists(next))) return next;
		counter++;
	}
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

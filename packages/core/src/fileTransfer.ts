import { createHash } from "node:crypto";
import {
	type FileHandle,
	access,
	mkdir,
	open,
	readFile,
	rename,
	stat,
	unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import {
	type FileChunkFramePayload,
	type FileEndMessage,
	type FileStartMessage,
	type Message,
	createFileAbort,
	createFileChunkAck,
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

/**
 * Cap on simultaneously open inbound transfers. Each one holds a file
 * handle, a temp file, and a Map entry — without a bound, a peer spraying
 * file-start messages exhausts fds (EMFILE).
 */
export const MAX_CONCURRENT_TRANSFERS = 8;

/** Emit a progress event at most once per this many received bytes. */
const PROGRESS_GRANULARITY_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// PR-5 — chunk-level ACK + selective retransmit (ADR 0003 Q2 / Q8 / F.5).
//
// The receiver fires `FileChunkAckMessage { transferId, bitmap, lastIndex }`
// every 32 received chunks AND on `file-end` AND on out-of-order detection
// (ADR 0003 Q8). The sender keeps an in-memory bitmap of unacked chunk
// indices per transferId; each inbound ACK updates that bitmap, and any
// chunk the receiver still reports missing is retransmitted. Chunks do
// NOT flow through the chat outbox (ADR 0003 F.5) — the bitmap ACK is
// the only recovery channel for file transfer.
//
// The PR-5 reframing of the old "out-of-order = protocol violation" rule
// is the centerpiece: out-of-order used to fail the transfer. Under the
// new model it merely asks the sender to retransmit. The transfer only
// fails when the sender exhausts a chunk's 5-attempt retry budget
// (ADR 0003 Q4-shaped policy, applied to chunks instead of messages).
// ---------------------------------------------------------------------------

/** PR-5 — every-32nd chunk + on-file-end ACK trigger (ADR 0003 Q8). */
const FILE_CHUNK_ACK_INTERVAL = 32;

/** PR-5 — initial delay before the first retransmit of an unacked chunk.
 *  Deliberately SLOW (2 s, same order as the chat outbox): SCTP already
 *  retransmits lost data on its own RTO, and this layer firing sooner
 *  stacks duplicate bulk traffic onto a congested association — measured
 *  on a lossy LAN as thousands of queued chunks and heartbeat starvation
 *  (2026-09-21 incident: transfer completes, connection dies seconds
 *  later). This scheduler owns the "SCTP made no progress for a long
 *  time" case, not fast loss recovery. */
const FILE_INITIAL_RETRANSMIT_MS = 2_000;
/** PR-5 — exponential backoff cap (mirrors chat outbox ADR 0003 Q4). */
const FILE_MAX_RETRANSMIT_MS = 30_000;
/** PR-5 — give up after this many attempts on a single chunk (ADR 0003 Q4). */
const FILE_MAX_RETRANSMIT_ATTEMPTS = 5;

/** PR-5 — how long the receiver waits after `file-end` for the sender's
 *  chunk-level retransmits to fill any gaps before validating. Covers
 *  the sender's first retransmit window (`FILE_INITIAL_RETRANSMIT_MS`)
 *  plus enough propagation headroom for a 130-chunk retransmit burst
 *  on the LAN. Constructor option `validationDelayMs` overrides this
 *  default; tests that don't exercise the recovery path pass 0 to
 *  keep the happy-path latency unchanged. */
const DEFAULT_FILE_END_VALIDATION_DELAY_MS = 3_000;

/**
 * PR-5 — default cap for the per-transfer unacked chunk bitmap.
 *
 * Picked to match the chat receive window (256, ADR 0003 Q7) so a
 * single transfer's bookkeeping stays in the same order of magnitude as
 * the chat dedup state. The cap is enforced as an LRU eviction on the
 * unacked-chunk Map (oldest entry is dropped when the cap is hit), so a
 * very long transfer silently forgets its earliest unacked indices —
 * the receiver's bitmap is the authoritative source of truth, and a
 * follow-up ACK that lands an evicted index will simply re-add it.
 */
export const DEFAULT_FILE_UNACKED_BITMAP_CAP = 256;

export type SendFileOptions = {
	onProgress?: (sentBytes: number, totalBytes: number) => void;
	/**
	 * Override the backpressure high-water mark. Tests force it low to pace
	 * the sender over many drain cycles without needing a huge file.
	 */
	highWaterBytes?: number;
};

export type SendFileResult = {
	/** The transferId the sender used — also returned for tests and observability. */
	transferId: string;
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
 * Stateless — the function streams and returns. PR-5's chunk-level ACK
 * recovery lives in `FileSender` (one instance per `PeerConnection`,
 * persists across `swapSession`). The function form is preserved for
 * backwards compatibility and for the existing unit tests that don't need
 * state retention.
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
			if (bytesRead === 0) {
				// The file shrank after we announced its size. Sending file-end
				// here would deliver a truncated file whose checksum "verifies"
				// — fail loudly so the receiver drops the partial instead.
				throw new Error(
					`Source file changed size during send (read stopped at ${position} of ${fileStat.size} bytes)`,
				);
			}
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
		return { transferId, bytesSent: position, checksum, durationMs: Date.now() - startedAt };
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

/**
 * PR-5 — sender-side event. Fires once per transfer when the 5-attempt
 * retry budget is exhausted for any one chunk (mirrors `outbox-abandoned`
 * for chat messages; the CLI surfaces this as a system message in PR-6).
 */
export type SenderTransferEvent =
	| { kind: "started"; transferId: string; fileName: string; fileSize: number }
	| { kind: "abandoned"; transferId: string; fileName: string; reason: string };

type ActiveTransfer = {
	fileName: string;
	fileSize: number;
	finalPath: string;
	tempPath: string;
	handle: FileHandle;
	// PR-5 — total unique bytes actually written to disk. Used to gate
	// the "exceeds announced file size" check and the file-end
	// completeness check. With out-of-order reception, duplicates don't
	// bump this number (the receiver dedups before writing).
	receivedBytes: number;
	// PR-5 — the contiguous-chunk cursor. Advances through `receivedIndices`
	// whenever the next expected chunk is already in the set (cascade).
	expectedNext: number;
	// PR-5 — set of chunk indices the receiver has actually written.
	// Backs the dedup, the every-32 ACK trigger, the bitmap in every
	// emitted FileChunkAckMessage, and the "all chunks received" check
	// before file-end can succeed.
	receivedIndices: Set<number>;
	// PR-5 — count of chunks accepted since the last FileChunkAckMessage
	// emission. Resets on emission; the every-32 trigger (Q8) fires when
	// it crosses the interval.
	chunksSinceLastAck: number;
	lastProgressAt: number;
};

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Streaming counterpart to {@link sendFile} / {@link FileSender}. Chunks
 * are written to a `<final>.part` temp file at `chunk.index * FILE_CHUNK_SIZE`
 * as they arrive (PR-5: out-of-order writes are allowed and bitmap-recovered
 * via FileChunkAckMessage). The file is atomically renamed into place only
 * after the sha256 in `file-end` checks out AND the receiver's received
 * bitmap shows every announced chunk landed — a crashed, aborted, or
 * incomplete transfer never leaves a plausible-looking partial file
 * behind, only a `.part` that the next event cleans up.
 *
 * `handleMessage` is synchronous to call but serializes its fs work on an
 * internal promise queue, preserving wire order across awaits.
 *
 * PR-5 — chunk-level ACK: `sendMessage` (constructor option) is the
 * outbound channel for `FileChunkAckMessage` frames. The receiver fires
 * one of these every 32 accepted chunks (ADR 0003 Q8), on `file-end`,
 * and on every out-of-order chunk (the new "request retransmit" path
 * that replaces the old `failTransfer("out-of-order chunk…")` rule).
 *
 * `sendMessage` is optional: callers that don't need to wire the ACK
 * (e.g. a passive receiver that only cares about completed files) get
 * the same receive-and-write behavior with the ACK frames dropped on
 * the floor.
 */
export class FileReceiver {
	private transfers = new Map<string, ActiveTransfer>();
	private queue: Promise<void> = Promise.resolve();
	private readonly downloadDir: string;
	private readonly onEvent?: (event: TransferEvent) => void;
	private readonly sendMessage?: (message: Message) => void;
	private readonly validationDelayMs: number;

	constructor(
		opts: {
			downloadDir?: string;
			onEvent?: (event: TransferEvent) => void;
			/** PR-5 — outbound dispatch for FileChunkAckMessage. Optional. */
			sendMessage?: (message: Message) => void;
			/**
			 * PR-5 — how long to wait after `file-end` for the sender's
			 * retransmits to fill any gap before validating. Only used
			 * when the post-file-end bitmap shows a gap (`expectedNext <
			 * totalChunks`); transfers that already have every chunk
			 * validate immediately. Default 3000 ms; tests pass 0 to
			 * keep the happy path synchronous.
			 */
			validationDelayMs?: number;
		} = {},
	) {
		this.downloadDir = opts.downloadDir ?? DEFAULT_DOWNLOAD_DIR;
		this.onEvent = opts.onEvent;
		this.sendMessage = opts.sendMessage;
		this.validationDelayMs = opts.validationDelayMs ?? DEFAULT_FILE_END_VALIDATION_DELAY_MS;
	}

	/** Feed file-start/-end/-abort messages; every other type is ignored. */
	handleMessage(message: Message): void {
		switch (message.type) {
			case "file-start":
				this.enqueue(() => this.startTransfer(message));
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
	 * Feed one inbound chunk frame. Chunks arrive on their own channel
	 * (binary frames, demuxed by the transport), not through
	 * `handleMessage`, so they never carry a synthesized id/timestamp.
	 */
	handleChunk(chunk: FileChunkFramePayload): void {
		this.enqueue(() => this.writeChunk(chunk));
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

	/**
	 * PR-5 — wait for the receiver's internal task queue to drain. The
	 * synchronous `handleMessage` / `handleChunk` calls enqueue fs work
	 * on a promise chain, so callers that need a deterministic
	 * post-handle state (tests, batch processors) can `await
	 * receiver.waitForIdle()` to flush the chain without disposing.
	 */
	async waitForIdle(): Promise<void> {
		await this.queue;
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
		if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
			getLogger().warn({ transferId, fileName, fileSize }, "invalid announced file size");
			this.emit({ kind: "failed", transferId, fileName, reason: "invalid announced file size" });
			return;
		}
		if (this.transfers.has(transferId)) {
			// Reusing an id would silently overwrite the Map entry and leak the
			// previous handle/temp file — fail the old one explicitly first.
			await this.failTransfer(transferId, "duplicate transfer id");
		}
		if (this.transfers.size >= MAX_CONCURRENT_TRANSFERS) {
			getLogger().warn(
				{ transferId, fileName, active: this.transfers.size },
				"too many concurrent transfers",
			);
			this.emit({
				kind: "failed",
				transferId,
				fileName,
				reason: `too many concurrent transfers (limit ${MAX_CONCURRENT_TRANSFERS})`,
			});
			return;
		}
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
			receivedBytes: 0,
			expectedNext: 0,
			receivedIndices: new Set(),
			chunksSinceLastAck: 0,
			lastProgressAt: 0,
		});
		getLogger().info({ transferId, fileName, fileSize }, "file receive started");
		this.emit({ kind: "started", transferId, fileName, fileSize });
	}

	private async writeChunk(chunk: FileChunkFramePayload): Promise<void> {
		const { transferId, index, data } = chunk;
		const transfer = this.transfers.get(transferId);
		if (!transfer) {
			getLogger().debug({ transferId, index }, "chunk for unknown transfer dropped");
			return;
		}

		// PR-5 — dedup. A retransmitted chunk (sender got no ACK and tried
		// again) lands here twice; the second one must NOT bump counters,
		// emit ACKs, or write to disk. The sender's bitmap is what knows
		// to stop retransmitting once it sees our ACK land.
		if (transfer.receivedIndices.has(index)) {
			getLogger().debug({ transferId, index }, "duplicate chunk dropped");
			return;
		}

		// PR-5 — out-of-order is no longer a failure (the old
		// "out-of-order chunk = protocol violation" rule, broken in PR-5
		// for the selective-retransmit recovery channel). We still bound
		// the chunk to the announced file size so a malicious peer can't
		// stream unlimited data.
		const chunkOffset = index * FILE_CHUNK_SIZE;
		if (chunkOffset >= transfer.fileSize) {
			await this.failTransfer(
				transferId,
				`received a chunk past the announced file size (index ${index}, file size ${transfer.fileSize})`,
			);
			return;
		}
		if (chunkOffset + data.length > transfer.fileSize) {
			await this.failTransfer(
				transferId,
				`received more data than the announced file size (${transfer.fileSize} bytes)`,
			);
			return;
		}

		// Write at the chunk's index-based offset. Out-of-order writes leave
		// holes in the temp file; the receiver doesn't seek past holes, and
		// the on-disk SHA256 is computed only over the bytes we actually
		// wrote. If the chunks arrive out of order, the gap is filled by a
		// later write at the same offset — POSIX guarantees this is safe
		// (the write just overwrites the sparse hole).
		await transfer.handle.write(data, 0, data.length, chunkOffset);
		transfer.receivedIndices.add(index);
		transfer.receivedBytes += data.length;

		// PR-5 — cascade `expectedNext` through contiguous received
		// indices. When the chunk we just wrote is exactly the one we
		// were waiting for, keep advancing while the next index is
		// already in `receivedIndices`. Without this cascade, a later
		// "all chunks received" check would under-report and the file-end
		// path would falsely fail a transfer whose chunks 0,2,1 arrived
		// in that order.
		if (index === transfer.expectedNext) {
			transfer.expectedNext += 1;
			while (transfer.receivedIndices.has(transfer.expectedNext)) {
				transfer.expectedNext += 1;
			}
		}

		if (transfer.receivedBytes - transfer.lastProgressAt >= PROGRESS_GRANULARITY_BYTES) {
			transfer.lastProgressAt = transfer.receivedBytes;
			this.emit({
				kind: "progress",
				transferId,
				fileName: transfer.fileName,
				receivedBytes: transfer.receivedBytes,
				totalBytes: transfer.fileSize,
			});
		}

		// PR-5 — ACK emission (ADR 0003 Q8 + the new out-of-order
		// "request retransmit" path):
		//   1. Every FILE_CHUNK_ACK_INTERVAL accepted chunks.
		//   2. On any out-of-order chunk (the index we just wrote is
		//      beyond `expectedNext` BEFORE the cascade — we save the
		//      pre-cascade cursor for the check).
		// Out-of-order detection is the centerpiece of the PR-5
		// reframing: the old code failed the transfer here; the new code
		// asks the sender to fill the gap. The bitmap we emit is the
		// receiver's truth — the sender reconciles its unacked set and
		// retransmits.
		transfer.chunksSinceLastAck += 1;
		const wasOutOfOrder = index !== transfer.expectedNext - 1 && index >= transfer.expectedNext;
		// After the cascade above, `expectedNext - 1` is the last index
		// the receiver holds contiguously; `index > that` means the chunk
		// was out-of-order relative to the receiver's run of contiguous
		// received indices.
		const contiguousUpTo = transfer.expectedNext - 1;
		const isOutOfOrder = index > contiguousUpTo;
		if (isOutOfOrder || transfer.chunksSinceLastAck >= FILE_CHUNK_ACK_INTERVAL) {
			this.sendChunkAck(transferId);
			transfer.chunksSinceLastAck = 0;
		}
		// wasOutOfOrder is captured for completeness; it's a stronger
		// "true gap detected" signal than `isOutOfOrder` (which can also
		// be true for an in-order chunk that lands after a cascade
		// filled the gap). Reserved for future telemetry; not asserted
		// here.
		void wasOutOfOrder;
	}

	private async finishTransfer(message: FileEndMessage): Promise<void> {
		const { transferId, checksum } = message.payload;
		const transfer = this.transfers.get(transferId);
		if (!transfer) {
			getLogger().debug({ transferId }, "file-end for unknown transfer dropped");
			return;
		}

		// PR-5 — emit one final FileChunkAckMessage so the sender has a
		// last chance to retransmit any chunk still missing from our
		// bitmap. The sender's retransmit timer may already be armed;
		// this final ACK collapses both paths into the same wire frame.
		this.sendChunkAck(transferId);

		// PR-5 — schedule the post-wait validation. Two paths:
		//
		//   * No gap (expectedNext >= totalChunks) → validation can run
		//     immediately, in this task. Awaiting it here keeps
		//     `waitForIdle()` callers honest: the "completed" event
		//     fires before the queue drains.
		//
		//   * Gap (some chunk still missing) → the sender's retransmits
		//     need to land first. setTimeout fires outside the queue
		//     so retransmit chunks can be enqueued (and processed)
		//     during the wait window. When the timer fires, the
		//     validation task joins the back of the queue and runs
		//     after every retransmit writeChunk that's been queued.
		const totalChunks = Math.ceil(transfer.fileSize / FILE_CHUNK_SIZE);
		if (transfer.expectedNext >= totalChunks) {
			await this.validateAfterEnd(transferId, checksum);
		} else {
			setTimeout(() => {
				void this.enqueue(() => this.validateAfterEnd(transferId, checksum));
			}, this.validationDelayMs);
		}
	}

	/**
	 * PR-5 — finalize the transfer after the wait window. Called via
	 * the queue from `finishTransfer`'s deferred timer so retransmit
	 * chunks can land on the queue in parallel. The transfer state is
	 * read fresh here; if it disappeared (e.g. another failure path)
	 * we no-op.
	 */
	private async validateAfterEnd(transferId: string, checksum: string): Promise<void> {
		const transfer = this.transfers.get(transferId);
		if (!transfer) return;

		const totalChunks = Math.ceil(transfer.fileSize / FILE_CHUNK_SIZE);

		if (transfer.expectedNext < totalChunks) {
			await this.failTransfer(
				transferId,
				`incomplete transfer (received ${transfer.expectedNext} of ${totalChunks} chunks)`,
			);
			return;
		}
		if (transfer.receivedBytes !== transfer.fileSize) {
			await this.failTransfer(
				transferId,
				`incomplete transfer (received ${transfer.receivedBytes} of ${transfer.fileSize} bytes)`,
			);
			return;
		}

		// PR-5 — hash the on-disk file rather than maintaining a running
		// hash as chunks land. With out-of-order reception the running
		// hash would mix chunks in receive order, not file order, so the
		// sha256 in `file-end` would never match. Re-reading the file is
		// one extra `readFile` per transfer; for a 100 MiB file on a LAN
		// disk it's sub-millisecond and the alternative (a "hash by
		// offset" structure) costs more memory than it's worth.
		await transfer.handle.close();
		const bytes = await readFile(transfer.tempPath);
		const actual = createHash("sha256").update(bytes).digest("hex");
		if (actual !== checksum) {
			this.transfers.delete(transferId);
			try {
				await unlink(transfer.tempPath);
			} catch {
				// already gone
			}
			this.emit({
				kind: "failed",
				transferId,
				fileName: transfer.fileName,
				reason: "checksum mismatch",
			});
			return;
		}
		this.transfers.delete(transferId);
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

	/**
	 * PR-5 — build a `FileChunkAckMessage` for one transfer and hand it to
	 * the outbound dispatcher. No-op when the receiver was constructed
	 * without `sendMessage` (passive consumers can ignore the ACK).
	 *
	 * `bitmap` is a bit-per-chunk view of `receivedIndices`, LSB-first
	 * within each byte, covering indices `0..lastIndex` inclusive.
	 * `lastIndex` is the highest index the receiver has any information
	 * about (i.e. the max index in `receivedIndices`, or `-1` if the
	 * receiver has seen nothing yet — the empty-bitmap / lastIndex=-1
	 * shape is how the sender learns "I have no info about this
	 * transfer, retransmit everything"). This deviates from the literal
	 * "currentExpectedNext - 1" wording in the PR-5 spec; using
	 * `expectedNext - 1` only would have collapsed every out-of-order
	 * chunk into invisibility (the sender would never learn it was
	 * missing anything past the contiguous run).
	 */
	private sendChunkAck(transferId: string): void {
		if (!this.sendMessage) return;
		const transfer = this.transfers.get(transferId);
		if (!transfer) return;
		const { bitmap, lastIndex } = buildChunkAckBitmap(transfer.receivedIndices);
		try {
			this.sendMessage(createFileChunkAck(transferId, bitmap, lastIndex));
		} catch (err) {
			getLogger().warn(
				{ err: errorText(err), transferId },
				"sendMessage threw while emitting FileChunkAckMessage",
			);
		}
	}
}

/**
 * PR-5 — build the `bitmap` / `lastIndex` pair for a `FileChunkAckMessage`.
 *
 * `bitmap` has `Math.ceil((lastIndex + 1) / 8)` bytes; bit `i` is set iff
 * `received.has(i)` and `i <= lastIndex`. Returns an empty bitmap when
 * `lastIndex === -1` (receiver has not received any chunk yet) — the
 * sender treats that as "no info, retransmit everything".
 */
function buildChunkAckBitmap(received: Set<number>): { bitmap: Uint8Array; lastIndex: number } {
	let maxIndex = -1;
	for (const i of received) {
		if (i > maxIndex) maxIndex = i;
	}
	if (maxIndex < 0) {
		return { bitmap: new Uint8Array(0), lastIndex: -1 };
	}
	const byteLength = Math.ceil((maxIndex + 1) / 8);
	const bitmap = new Uint8Array(byteLength);
	for (const i of received) {
		if (i > maxIndex) continue;
		bitmap[Math.floor(i / 8)] |= 1 << (i % 8);
	}
	return { bitmap, lastIndex: maxIndex };
}

// ---------------------------------------------------------------------------
// PR-5 — FileSender: chunk-level ACK + selective retransmit.
//
// One instance per `PeerConnection`. Created lazily on the first
// `sendFile` call; persists across `swapSession` so the unacked-chunk
// bitmap and per-chunk retry timers survive a transport swap. When the
// peer eventually ACKs every chunk the sender drops the per-transfer
// state; if 5 retries on any one chunk exhaust without an ACK clearing
// it, the sender emits `transfer-abandoned` and a best-effort
// `file-abort` so the receiver can drop its partial temp file.
//
// The channel surface comes from a `getChannel()` callback, not a held
// reference: a transport swap simply rewires the callback's return
// value, and the sender's pending retransmits resume against the new
// channel automatically.
// ---------------------------------------------------------------------------

type SenderTransferState = {
	transferId: string;
	fileName: string;
	fileSize: number;
	totalChunks: number;
	handle: FileHandle;
	startedAt: number;
	highWater: number;
	// PR-5 — chunk indices the receiver has not yet confirmed. Set on
	// every send (initial pass) and on every inbound ACK that reports
	// the chunk as still missing. Cleared (and its timer torn down) on
	// every inbound ACK that reports the chunk as received. Survives
	// `swapSession` because the FileSender itself survives.
	unackedIndices: Map<number, true>;
	// PR-5 — per-chunk retry counters (ADR 0003 Q4-shaped policy,
	// applied to chunks). After 5 attempts on any one chunk, the
	// transfer is abandoned.
	retryCounters: Map<number, number>;
	// PR-5 — active retransmit timers per chunk index. Cleared on
	// every successful ACK of that chunk.
	retryTimers: Map<number, ReturnType<typeof setTimeout>>;
};

export type FileSenderOptions = {
	/**
	 * Returns the current `SendChannel`, or `null` when no session is
	 * active (transport swap in flight). Retransmit timers that fire
	 * against a `null` channel are deferred to the next ACK-driven
	 * reschedule; the per-chunk retry counter still advances so the
	 * 5-attempt budget remains the source of truth.
	 */
	getChannel: () => SendChannel | null;
	/**
	 * Fires once per transfer whose retry budget is exhausted.
	 * The CLI surfaces this as a system message in PR-6.
	 */
	onTransferAbandoned: (transferId: string) => void;
	/** Optional override for the initial chunk retransmit delay. */
	initialRetransmitMs?: number;
	/** Optional override for the exponential backoff cap. */
	maxRetransmitMs?: number;
	/** Optional override for the per-chunk retry budget. */
	maxRetransmitAttempts?: number;
	/** Optional override for the unacked-chunk bitmap LRU cap. */
	unackedBitmapCap?: number;
};

/**
 * Per-peer chunk-level ACK sender. Holds one state map per active
 * outbound transfer. Streams chunks synchronously through `sendFile`
 * (returns when `file-end` is sent, not when the transfer is fully
 * acked), then continues to drive retransmits in the background until
 * every chunk is acknowledged or the retry budget is exhausted.
 */
export class FileSender {
	private readonly transfers = new Map<string, SenderTransferState>();
	private readonly getChannel: () => SendChannel | null;
	private readonly onTransferAbandoned: (transferId: string) => void;
	private readonly initialRetransmitMs: number;
	private readonly maxRetransmitMs: number;
	private readonly maxRetransmitAttempts: number;
	private readonly unackedBitmapCap: number;
	private disposed = false;

	constructor(options: FileSenderOptions) {
		this.getChannel = options.getChannel;
		this.onTransferAbandoned = options.onTransferAbandoned;
		this.initialRetransmitMs = options.initialRetransmitMs ?? FILE_INITIAL_RETRANSMIT_MS;
		this.maxRetransmitMs = options.maxRetransmitMs ?? FILE_MAX_RETRANSMIT_MS;
		this.maxRetransmitAttempts = options.maxRetransmitAttempts ?? FILE_MAX_RETRANSMIT_ATTEMPTS;
		this.unackedBitmapCap = options.unackedBitmapCap ?? DEFAULT_FILE_UNACKED_BITMAP_CAP;
	}

	/**
	 * Stream a file to the peer. Returns once `file-end` has been sent;
	 * the per-transfer retransmit timers continue in the background
	 * after this resolves. Throws "Data channel not ready" when no
	 * channel is currently available (callers can retry against a
	 * future session).
	 */
	async sendFile(path: string, options?: SendFileOptions): Promise<SendFileResult> {
		const channel = this.getChannel();
		if (!channel) {
			throw new Error("Data channel not ready");
		}
		const fileStat = await stat(path);
		if (!fileStat.isFile()) {
			throw new Error(`Not a regular file: ${path}`);
		}
		const highWater = options?.highWaterBytes ?? BUFFERED_AMOUNT_HIGH_WATER;
		const transferId = crypto.randomUUID();
		const fileName = basename(path);
		const startedAt = Date.now();
		const totalChunks = Math.ceil(fileStat.size / FILE_CHUNK_SIZE);
		channel.send(createFileStart(fileName, fileStat.size, FILE_CHUNK_SIZE, transferId));

		const handle = await open(path, "r");
		const hash = createHash("sha256");
		const state: SenderTransferState = {
			transferId,
			fileName,
			fileSize: fileStat.size,
			totalChunks,
			handle,
			startedAt,
			highWater,
			unackedIndices: new Map(),
			retryCounters: new Map(),
			retryTimers: new Map(),
		};
		this.transfers.set(transferId, state);

		try {
			const buffer = new Uint8Array(FILE_CHUNK_SIZE);
			let position = 0;
			let index = 0;
			while (position < fileStat.size) {
				const { bytesRead } = await handle.read(buffer, 0, FILE_CHUNK_SIZE, position);
				if (bytesRead === 0) {
					throw new Error(
						`Source file changed size during send (read stopped at ${position} of ${fileStat.size} bytes)`,
					);
				}
				const chunk = buffer.subarray(0, bytesRead);
				hash.update(chunk);
				channel.sendBinary(encodeFileChunkFrame(transferId, index, chunk));
				position += bytesRead;
				index++;
				// PR-5 — track this chunk as awaiting ACK. Cap-bounded LRU
				// so a transfer with thousands of chunks doesn't pin a
				// proportional amount of memory in the per-transfer state.
				this.addUnacked(state, index - 1);
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
			return {
				transferId,
				bytesSent: position,
				checksum,
				durationMs: Date.now() - startedAt,
			};
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			this.abandonTransfer(state, reason, /* sendAbort */ true);
			throw err;
		}
	}

	/**
	 * PR-5 — process an inbound `FileChunkAckMessage`. The bitmap tells
	 * us which chunk indices the receiver has for `transferId`:
	 *
	 *   * Bit `i` set → receiver has chunk `i` → remove from
	 *     `unackedIndices`, clear its retry counter and timer.
	 *   * Bit `i` clear (and `i <= lastIndex`) → receiver is missing
	 *     chunk `i` → ensure `i` is in `unackedIndices` (it usually
	 *     already is; the explicit add handles the cap-evicted case).
	 *   * `i > lastIndex` → out of bitmap range; leave unackedIndices
	 *     alone (the receiver hasn't told us anything about it).
	 *
	 * After reconciliation, every index still in `unackedIndices`
	 * gets its retry timer (re)armed. The very first retransmit uses
	 * the initial delay; subsequent ones exponentially back off up to
	 * the cap. Five failed attempts on any one chunk → abandon.
	 */
	noteChunkAck(payload: { transferId: string; bitmap: Uint8Array; lastIndex: number }): void {
		const state = this.transfers.get(payload.transferId);
		if (!state) return;
		const { bitmap, lastIndex } = payload;

		// Iterate the bitmap. Bits set → remove from unacked; bits
		// clear (within range) → ensure present.
		if (lastIndex >= 0 && bitmap.byteLength > 0) {
			for (let i = 0; i <= lastIndex; i++) {
				const byte = bitmap[Math.floor(i / 8)] ?? 0;
				const bit = (byte >> (i % 8)) & 1;
				if (bit === 1) {
					if (state.unackedIndices.delete(i)) {
						// Successfully cleared — tear down the retry timer.
						const timer = state.retryTimers.get(i);
						if (timer) clearTimeout(timer);
						state.retryTimers.delete(i);
						state.retryCounters.delete(i);
					}
				} else {
					// Receiver confirms missing → make sure we're tracking it.
					this.addUnacked(state, i);
				}
			}
		}

		// (Re)arm retransmits for everything still unacked.
		for (const i of state.unackedIndices.keys()) {
			this.scheduleRetransmit(state, i);
		}

		// If every chunk is now acked, the per-transfer state can be
		// dropped — there's nothing left to retransmit and no timer to
		// fire. Keep the file handle closed so the os can release the
		// fd; the next sendFile for the same transferId is a fresh
		// start (id collisions are the receiver's problem to flag).
		if (state.unackedIndices.size === 0) {
			void state.handle.close().catch(() => {});
			this.transfers.delete(state.transferId);
		}
	}

	/**
	 * Test-only / observability: how many chunks for `transferId` are
	 * still waiting for an ACK. Returns 0 for unknown / completed
	 * transfers.
	 */
	unackedCount(transferId: string): number {
		const state = this.transfers.get(transferId);
		return state ? state.unackedIndices.size : 0;
	}

	/**
	 * Test-only / app cleanup. Cancels every retransmit timer, closes
	 * any open file handles, drops all per-transfer state. Idempotent.
	 */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const states = [...this.transfers.values()];
		this.transfers.clear();
		for (const state of states) {
			for (const timer of state.retryTimers.values()) clearTimeout(timer);
			await state.handle.close().catch(() => {});
		}
	}

	private addUnacked(state: SenderTransferState, index: number): void {
		// LRU-style cap: when the unacked set is at capacity, evict the
		// oldest entry (insertion order in a Map is well-defined). The
		// evicted index is forgotten until the next ACK that names it
		// — the receiver's bitmap is the authoritative source of truth,
		// so re-adding on a follow-up ACK is fine.
		if (!state.unackedIndices.has(index) && state.unackedIndices.size >= this.unackedBitmapCap) {
			const oldest = state.unackedIndices.keys().next().value;
			if (oldest !== undefined) {
				state.unackedIndices.delete(oldest);
				const timer = state.retryTimers.get(oldest);
				if (timer) clearTimeout(timer);
				state.retryTimers.delete(oldest);
				state.retryCounters.delete(oldest);
			}
		}
		state.unackedIndices.set(index, true);
	}

	private scheduleRetransmit(state: SenderTransferState, index: number): void {
		// Don't double-arm. If a timer is already pending for this
		// chunk, the existing schedule is the source of truth.
		if (state.retryTimers.has(index)) return;

		const attempts = (state.retryCounters.get(index) ?? 0) + 1;
		if (attempts > this.maxRetransmitAttempts) {
			this.abandonTransfer(
				state,
				`chunk ${index} failed after ${this.maxRetransmitAttempts} retransmits`,
				/* sendAbort */ true,
			);
			return;
		}
		state.retryCounters.set(index, attempts);

		const delay = Math.min(this.initialRetransmitMs * 2 ** (attempts - 1), this.maxRetransmitMs);
		const timer = setTimeout(() => {
			state.retryTimers.delete(index);
			void this.fireRetransmit(state, index);
		}, delay);
		state.retryTimers.set(index, timer);
	}

	private async fireRetransmit(state: SenderTransferState, index: number): Promise<void> {
		const channel = this.getChannel();
		if (!channel) {
			// No live transport — defer. We re-arm the timer at the
			// existing delay so the retry budget keeps advancing; the
			// timer is harmless when there's no channel to send on.
			// A future `noteChunkAck` (which can arrive over the same
			// dead channel's control-plane? — no, the channel is gone)
			// or a future sendFile call that brings the channel back
			// will reschedule via noteChunkAck. To avoid waiting on
			// the dead timer forever, just re-arm here so the cap
			// doesn't stall the abandon path.
			this.scheduleRetransmit(state, index);
			return;
		}
		const offset = index * FILE_CHUNK_SIZE;
		const length = Math.min(FILE_CHUNK_SIZE, state.fileSize - offset);
		if (length <= 0) {
			this.abandonTransfer(state, `chunk ${index} offset past file size`, true);
			return;
		}
		const buffer = new Uint8Array(length);
		let bytesRead: number;
		try {
			const result = await state.handle.read(buffer, 0, length, offset);
			bytesRead = result.bytesRead;
		} catch (err) {
			this.abandonTransfer(
				state,
				`chunk ${index} read failed: ${err instanceof Error ? err.message : String(err)}`,
				true,
			);
			return;
		}
		if (bytesRead !== length) {
			this.abandonTransfer(state, `chunk ${index} short read (${bytesRead} of ${length})`, true);
			return;
		}
		try {
			channel.sendBinary(encodeFileChunkFrame(state.transferId, index, buffer));
		} catch (err) {
			// Send threw — treat as a failed attempt and re-arm so the
			// budget eventually gives up if the channel stays broken.
			getLogger().warn(
				{ err: errorText(err), transferId: state.transferId, index },
				"chunk retransmit: sendBinary threw",
			);
			this.scheduleRetransmit(state, index);
			return;
		}
		// Arm the next attempt (if any budget remains).
		this.scheduleRetransmit(state, index);
	}

	private abandonTransfer(state: SenderTransferState, reason: string, sendAbort: boolean): void {
		if (!this.transfers.has(state.transferId)) return;
		this.transfers.delete(state.transferId);
		for (const timer of state.retryTimers.values()) clearTimeout(timer);
		if (sendAbort) {
			const channel = this.getChannel();
			if (channel) {
				try {
					channel.send(createFileAbort(state.transferId, reason));
				} catch {
					// Best effort; the channel may itself be the thing that died.
				}
			}
		}
		void state.handle.close().catch(() => {});
		getLogger().warn(
			{ transferId: state.transferId, fileName: state.fileName, reason },
			"file transfer abandoned",
		);
		this.onTransferAbandoned(state.transferId);
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

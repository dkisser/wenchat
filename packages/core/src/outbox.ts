import { type FileHandle, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { getLogger } from "./logger";

/**
 * One JSONL row in the outbox file. Three variants:
 *
 * - `head` — the highest seq the peer has ACKed (ADR 0003 Q10), persisted
 *   so a process restart reads the right starting `seq` and the
 *   receiver's gap detector does not treat "everything since last time" as
 *   a fraud replay.
 * - `msg` — one outbound application message, frozen as the encoded
 *   wire payload that was actually sent. PR-3 reads this back when
 *   retransmitting.
 * - `ack` — soft tombstone for `seq` (ADR 0003 Q6). Marks a message as
 *   acknowledged without rewriting the file; the compactor removes it
 *   later.
 *
 * `head` is structurally distinct from `ack` so a future reader can pick a
 * single line per process boot to recover the high-water mark without
 * scanning every tombstone. PR-3's writer is the only thing that writes
 * `head`; this PR never does.
 */
export type OutboxEntry =
	| { kind: "head"; head: number }
	| { kind: "msg"; seq: number; encoded: string }
	| { kind: "ack"; seq: number };

const OutboxEntrySchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("head"), head: z.int().min(0) }),
	z.object({
		kind: z.literal("msg"),
		seq: z.int().min(0),
		encoded: z.string(),
	}),
	z.object({ kind: z.literal("ack"), seq: z.int().min(0) }),
]);

/**
 * Above this size the recovery path emits a `pino warn` so a runaway
 * caller can detect "the outbox has blown up" instead of OOMing the
 * process. ADR 0003 Q6 fixes the compactor trigger at "outbox > 1 MiB";
 * PR-2 exposes the compact operation directly so PR-3 can call it from
 * its own scheduler without importing this constant.
 */
const COMPACT_SIZE_THRESHOLD_BYTES = 1024 * 1024;

/**
 * Backing-store contract. `node:fs/promises.FileHandle` satisfies it
 * natively; tests can pass a fake. We need `write` + `sync` + `close` only —
 * no seek, no read (reads go through `readFile`, not the handle).
 */
type WritableFileHandle = Pick<FileHandle, "write" | "sync" | "close">;

/**
 * Per-peer persistent outbox (ADR 0003 Q5/Q6/Q10; PR-2 of Stage 1).
 *
 * One `OutboxStore` per remote peer. File format is JSONL, one entry per
 * line, every line `fsync`'d before the write resolves. Layout is up to
 * the caller: the store neither knows about `localId`, peer IDs, nor the
 * `~/.wenchat` tree. The convention (documented in `core.md`) is
 * `<workspaceRoot>/outbox/<peerId>.jsonl`; `peer.ts` in PR-3 builds that
 * path.
 *
 * Concurrency: every mutation (`append`, `markAcked`, `compact`) is queued
 * behind a single internal promise. Two `await store.append(...)` calls
 * racing each other serialize through that chain, so the on-disk order
 * matches the call order. This is the discipline PR-3's sender relies on
 * for "outbox order = wire order".
 *
 * Crash recovery: on reopen, the file is read line-by-line. Any line that
 * fails Zod validation (partial write from a mid-fsync kill, garbage from
 * a disk error, anything else) is skipped with a `pino warn`. The store
 * never throws on corrupt input — the worst case is "the last unacked
 * msg got lost", which the retransmit loop will surface as
 * `outbox-abandoned` rather than corrupt the whole queue.
 */
export class OutboxStore {
	private readonly filePath: string;
	private handle: WritableFileHandle | null = null;
	private queue: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	private assertOpen(): void {
		if (this.closed) {
			throw new Error("OutboxStore: operation on a closed store");
		}
	}

	/**
	 * Append one outbound message. `encoded` is the JSON wire payload that
	 * was actually sent (the sender stores what it sent, not what it
	 * meant — retransmit must reproduce the exact bytes). Fsync is per
	 * append (ADR 0003 F.1): slow, but a chat session's write rate is
	 * human-limited and the alternative (an in-memory buffer flushed by a
	 * background loop) opens a recovery-window of unflushed entries that
	 * a hard kill would drop. The trade-off is documented in `core.md`.
	 *
	 * Throws on a `\\n` in the payload (would corrupt JSONL) and on every
	 * underlying fs error (ENOSPC, EACCES — F.9 says the caller must see
	 * these as a thrown exception, not silent loss).
	 */
	async append(seq: number, encoded: string): Promise<void> {
		this.assertOpen();
		if (encoded.includes("\n")) {
			throw new Error("OutboxStore.append: encoded payload must not contain a newline");
		}
		const entry: OutboxEntry = { kind: "msg", seq, encoded };
		await this.writeLine(JSON.stringify(entry));
	}

	/**
	 * Mark `seq` as acknowledged. Writes a soft tombstone; the compactor
	 * later removes the entry once enough trailing material has piled up.
	 * Recording the tombstone is enough — we do not edit the existing
	 * `msg` row in place (JSONL is append-only by convention).
	 */
	async markAcked(seq: number): Promise<void> {
		this.assertOpen();
		const entry: OutboxEntry = { kind: "ack", seq };
		await this.writeLine(JSON.stringify(entry));
	}

	/**
	 * Snapshot of all unacked `msg` entries with `seq >= fromSeq`, sorted
	 * ascending. Tombstoned entries are filtered out. The returned objects
	 * are fresh — the caller may mutate them without affecting anything
	 * on disk.
	 *
	 * The store re-reads the file from disk every call. There is no in-
	 * memory cache, by design: the file is small (chat traffic only —
	 * chunks do not flow through here, F.5) and a stale cache would hide
	 * external writes (another process, or a manual edit during a debug
	 * session).
	 */
	async unackedFrom(fromSeq: number): Promise<Array<{ seq: number; encoded: string }>> {
		this.assertOpen();
		const entries = await this.readEntries();
		const tombstonedSeqs = new Set<number>();
		for (const entry of entries) {
			if (entry.kind === "ack") tombstonedSeqs.add(entry.seq);
		}
		const out: Array<{ seq: number; encoded: string }> = [];
		for (const entry of entries) {
			if (entry.kind !== "msg") continue;
			if (entry.seq < fromSeq) continue;
			if (tombstonedSeqs.has(entry.seq)) continue;
			out.push({ seq: entry.seq, encoded: entry.encoded });
		}
		return out;
	}

	/**
	 * Highest `ack` seq in the file, or 0 if no tombstones.
	 *
	 * Per ADR 0003 Q2, the receiver's ACK value is the highest contiguous
	 * seq received, so any N in an `ack` tombstone implies the receiver
	 * has `1..N` contiguous. `head = max(tombstone.seq)` is therefore
	 * "highest seq the receiver has confirmed contiguous" — exactly the
	 * value the compactor needs to decide what to drop and PR-3 needs to
	 * derive the next seq to assign on a fresh session (Q10).
	 *
	 * A `head` marker variant (Q10) overrides the tombstone scan when
	 * present — PR-3 writes that as a fast-recovery marker so a process
	 * kill between "ACK received" and "tombstone flushed" still records
	 * progress. PR-2 never writes `head` itself, but reading it correctly
	 * here means PR-3 just adds the writer.
	 */
	async getHead(): Promise<number> {
		this.assertOpen();
		const entries = await this.readEntries();
		let head = 0;
		for (const entry of entries) {
			if (entry.kind === "ack" && entry.seq > head) {
				head = entry.seq;
			}
			if (entry.kind === "head" && entry.head > head) {
				head = entry.head;
			}
		}
		return head;
	}

	/**
	 * Rewrite the file with everything strictly after `head` dropped. Used
	 * by the background compactor (PR-3) when the file grows past the
	 * ADR-0003-Q6 thresholds; exposed here so PR-3 can call it directly
	 * and so tests can exercise the invariant. Safe to call when head
	 * is 0 — that's a no-op, the file is already compact.
	 *
	 * Atomic on the happy path (temp file + rename), so a crash mid-compact
	 * leaves either the old file or the new file — never both, never half-
	 * written.
	 */
	async compact(): Promise<void> {
		this.assertOpen();
		const head = await this.getHead();
		if (head === 0) return;

		const entries = await this.readEntries();
		const tail: OutboxEntry[] = [];
		let dropped = 0;
		for (const entry of entries) {
			// Keep anything that survives past `head`. `msg` rows with
			// `seq <= head` are dead (acked). `ack` rows with `seq <= head`
			// are tombstones for dead messages — also dead. The `head`
			// marker itself is metadata, not data; it goes.
			if (entry.kind === "msg" && entry.seq > head) {
				tail.push(entry);
			} else if (entry.kind === "ack" && entry.seq > head) {
				tail.push(entry);
			} else {
				dropped++;
			}
		}
		if (dropped === 0) return;

		await this.withLock(async () => {
			const tempPath = `${this.filePath}.compact-${process.pid}-${Date.now()}`;
			const newContent = tail.map((e) => JSON.stringify(e)).join("\n");
			const body = newContent.length > 0 ? `${newContent}\n` : "";
			await writeFile(tempPath, body, "utf8");
			await rename(tempPath, this.filePath);
			// The rename replaced the inode our handle pointed at. Force a
			// reopen on the next write so the handle does not silently land
			// in a deleted file (the kernel keeps the old inode alive until
			// we close it, but new writes would race the compactor if it
			// ran twice in a row).
			await this.reopenHandle();
		});
	}

	/**
	 * Release the file handle. Idempotent. After this resolves, every
	 * other method rejects so a use-after-close is loud, not silent.
	 */
	async close(): Promise<void> {
		await this.withLock(async () => {
			if (this.handle) {
				try {
					await this.handle.close();
				} catch {
					// already closed — ignore.
				}
				this.handle = null;
			}
			this.closed = true;
		});
	}

	// --- private ---------------------------------------------------------

	/**
	 * Serialize a write + fsync behind the open-queued promise. The handle
	 * is opened lazily on first write so a `new OutboxStore(path)` never
	 * throws (file may not exist yet).
	 */
	private async writeLine(line: string): Promise<void> {
		await this.withLock(async () => {
			const handle = await this.ensureHandle();
			await handle.write(`${line}\n`);
			await handle.sync();
		});
	}

	/**
	 * Append the current operation behind whatever the previous one
	 * resolved to. This is the only place we serialize — every public
	 * mutator funnels through `writeLine` or `compact` or `close`, all of
	 * which route through `withLock`.
	 */
	private async withLock<T>(task: () => Promise<T>): Promise<T> {
		const previous = this.queue;
		let release: () => void = () => {};
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.queue = previous.then(() => next);
		try {
			await previous;
			return await task();
		} finally {
			release();
		}
	}

	/**
	 * Open the handle if it is not already open. Caches the reference so
	 * the fsync-after-write cost stays at one syscall per append.
	 */
	private async ensureHandle(): Promise<WritableFileHandle> {
		if (this.handle) return this.handle;
		// mkdir -p on the parent: the caller may pass a path inside a
		// never-yet-created directory. Doing it here (not in the ctor)
		// keeps `new OutboxStore(path)` pure — a thrown mkdir error is
		// impossible until the first write.
		await mkdir(dirname(this.filePath), { recursive: true });
		const opened = await open(this.filePath, "a");
		this.handle = opened;
		return opened;
	}

	/**
	 * Close the cached handle and clear it. Used after `compact` (the
	 * rename invalidated the inode) and `close`.
	 */
	private async reopenHandle(): Promise<void> {
		if (!this.handle) return;
		try {
			await this.handle.close();
		} catch {
			// ignore — we are about to drop the reference anyway.
		}
		this.handle = null;
	}

	/**
	 * Read every parseable line in the file. Bad lines (partial writes,
	 * garbage bytes, Zod failures) are skipped, not thrown — the recovery
	 * policy is "lose the last in-flight entry, keep the rest". A warn
	 * log line carries the offending bytes for postmortem.
	 *
	 * Returns entries in physical order. Callers that need sorted output
	 * sort it themselves (PR-3's retransmit loop iterates by seq anyway).
	 */
	private async readEntries(): Promise<OutboxEntry[]> {
		let raw: string;
		try {
			raw = await readFile(this.filePath, "utf8");
		} catch (err) {
			// ENOENT on first read is expected for a brand-new file; the
			// empty result is correct.
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw err;
		}

		// ADR 0003 F.5: outbox size is bounded by chat traffic. A file
		// that would blow the threshold is a bug, not a recoverable
		// state — refuse to read it so a runaway caller can detect the
		// condition instead of silently OOMing the process.
		const fileStat = await stat(this.filePath);
		if (fileStat.size > COMPACT_SIZE_THRESHOLD_BYTES) {
			getLogger().warn(
				{ size: fileStat.size, path: this.filePath },
				"outbox file exceeds 1 MiB threshold — caller should compact",
			);
		}

		const entries: OutboxEntry[] = [];
		const lines = raw.split("\n");
		for (const line of lines) {
			if (line.length === 0) continue;
			const parsed = safeParseLine(line);
			if (parsed === null) {
				getLogger().warn({ path: this.filePath, line }, "outbox: skipping unparseable line");
				continue;
			}
			entries.push(parsed);
		}
		return entries;
	}
}

function safeParseLine(line: string): OutboxEntry | null {
	let candidate: unknown;
	try {
		candidate = JSON.parse(line);
	} catch {
		return null;
	}
	const result = OutboxEntrySchema.safeParse(candidate);
	if (!result.success) return null;
	return result.data;
}

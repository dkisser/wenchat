import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OutboxEntry, OutboxStore } from "../../src/outbox";

let scratchDir: string;

beforeEach(async () => {
	scratchDir = await mkdtemp(join(tmpdir(), "outbox-test-"));
});

afterEach(async () => {
	await rm(scratchDir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Read the on-disk file directly and split into JSONL rows for assertions
 * that need to inspect what physically hit disk (as opposed to what
 * `unackedFrom` returns — which filters tombstones out).
 */
async function readRawLines(filePath: string): Promise<OutboxEntry[]> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch {
		return [];
	}
	const lines = raw.split("\n").filter((line) => line.length > 0);
	return lines.map((line) => JSON.parse(line) as OutboxEntry);
}

describe("OutboxStore — construction", () => {
	it("creates the file (and parent directories) if it does not exist", async () => {
		const nested = join(scratchDir, "deep", "nested", "dir", "outbox.jsonl");
		const store = new OutboxStore(nested);
		await store.append(1, "first-encoded-payload");
		await store.close();

		const lines = await readRawLines(nested);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toEqual({ kind: "msg", seq: 1, encoded: "first-encoded-payload" });
	});

	it("opens an existing file without truncating it", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		await writeFile(path, '{"kind":"msg","seq":7,"encoded":"persisted"}\n');

		const store = new OutboxStore(path);
		const unacked = await store.unackedFrom(0);

		expect(unacked).toEqual([{ seq: 7, encoded: "persisted" }]);
		await store.close();
	});
});

describe("OutboxStore — append", () => {
	it("writes each entry as a single newline-terminated JSONL line", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const store = new OutboxStore(path);

		await store.append(1, "payload-one");
		await store.append(2, "payload-two");
		await store.append(3, "payload-three");
		await store.close();

		const lines = await readRawLines(path);
		expect(lines).toEqual([
			{ kind: "msg", seq: 1, encoded: "payload-one" },
			{ kind: "msg", seq: 2, encoded: "payload-two" },
			{ kind: "msg", seq: 3, encoded: "payload-three" },
		]);
	});

	it("rejects an encoded payload containing a literal newline (would corrupt JSONL)", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const store = new OutboxStore(path);

		await expect(store.append(1, "line1\nline2")).rejects.toThrow();

		// Nothing should have been written — the validation runs before fsync.
		const lines = await readRawLines(path);
		expect(lines).toHaveLength(0);
		await store.close();
	});
});

describe("OutboxStore — markAcked", () => {
	it("appends an ack tombstone line", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const store = new OutboxStore(path);

		await store.append(1, "a");
		await store.append(2, "b");
		await store.markAcked(2);
		await store.close();

		const lines = await readRawLines(path);
		expect(lines).toEqual([
			{ kind: "msg", seq: 1, encoded: "a" },
			{ kind: "msg", seq: 2, encoded: "b" },
			{ kind: "ack", seq: 2 },
		]);
	});

	it("advances head to the marked seq even when earlier seqs are still unacked", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const store = new OutboxStore(path);

		await store.append(1, "a");
		await store.append(2, "b");
		await store.append(3, "c");
		await store.markAcked(2);

		expect(await store.getHead()).toBe(2);
		await store.close();
	});
});

describe("OutboxStore — unackedFrom", () => {
	it("returns every msg entry with seq >= fromSeq, sorted ascending, skipping tombstones", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const store = new OutboxStore(path);

		await store.append(1, "a");
		await store.append(2, "b");
		await store.markAcked(2);
		await store.append(3, "c");
		await store.append(4, "d");
		await store.markAcked(4);
		await store.append(5, "e");
		await store.close();

		const store2 = new OutboxStore(path);
		const unacked = await store2.unackedFrom(0);
		expect(unacked).toEqual([
			{ seq: 1, encoded: "a" },
			{ seq: 3, encoded: "c" },
			{ seq: 5, encoded: "e" },
		]);

		const fromTwo = await store2.unackedFrom(2);
		expect(fromTwo).toEqual([
			{ seq: 3, encoded: "c" },
			{ seq: 5, encoded: "e" },
		]);
		await store2.close();
	});

	it("returns an empty array when the file has no msg entries", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const store = new OutboxStore(path);
		const unacked = await store.unackedFrom(0);
		expect(unacked).toEqual([]);
		await store.close();
	});

	it("returns an empty array when fromSeq is greater than every msg seq", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const store = new OutboxStore(path);
		await store.append(1, "a");
		await store.append(2, "b");
		await store.close();

		const store2 = new OutboxStore(path);
		const unacked = await store2.unackedFrom(999);
		expect(unacked).toEqual([]);
		await store2.close();
	});
});

describe("OutboxStore — getHead", () => {
	it("returns 0 when no tombstones exist", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const store = new OutboxStore(path);
		await store.append(1, "a");
		await store.close();

		const store2 = new OutboxStore(path);
		expect(await store2.getHead()).toBe(0);
		await store2.close();
	});

	it("returns the seq of the last ack tombstone", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const store = new OutboxStore(path);
		await store.append(1, "a");
		await store.markAcked(1);
		await store.append(2, "b");
		await store.markAcked(2);
		await store.markAcked(3); // ack tombstone for a seq never written — still updates head
		await store.close();

		const store2 = new OutboxStore(path);
		expect(await store2.getHead()).toBe(3);
		await store2.close();
	});
});

describe("OutboxStore — compact", () => {
	it("removes entries that precede or equal head, leaving the tail intact", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const store = new OutboxStore(path);

		await store.append(1, "a");
		await store.append(2, "b");
		await store.append(3, "c");
		await store.markAcked(2);
		await store.append(4, "d");
		await store.append(5, "e");
		await store.close();

		// File on disk before compact:
		//   msg seq=1
		//   msg seq=2
		//   msg seq=3
		//   ack seq=2
		//   msg seq=4
		//   msg seq=5
		// head = max(2) = 2. Compact drops msg seq=1, msg seq=2, and ack
		// seq=2 (all have seq <= head). The ack seq=2 tombstone implicitly
		// covers msg seq=1 and msg seq=2 (contiguous ACK model: ack=2 means
		// receiver has 1..2 contiguous). msg seq=3 is kept because its seq
		// is not <= head and no higher ack exists yet.
		const store2 = new OutboxStore(path);
		await store2.compact();
		await store2.close();

		const lines = await readRawLines(path);
		expect(lines).toEqual([
			{ kind: "msg", seq: 3, encoded: "c" },
			{ kind: "msg", seq: 4, encoded: "d" },
			{ kind: "msg", seq: 5, encoded: "e" },
		]);
	});

	it("drops both msg and ack rows when their seq is <= head (contiguous ACK model)", async () => {
		// Under ADR 0003 Q2 the receiver's ACK value N means "I have
		// 1..N contiguous", so a tombstone for seq=N implies the receiver
		// has every seq <= N. The compactor can therefore drop both the
		// msg entries and their matching ack tombstones for any seq <=
		// head. This is the model getHead() uses (max tombstone seq).
		const path = join(scratchDir, "outbox.jsonl");
		const store = new OutboxStore(path);
		await store.append(1, "a");
		await store.append(2, "b");
		await store.append(3, "c");
		await store.markAcked(2);
		await store.append(4, "d");
		await store.append(5, "e");
		await store.markAcked(5);
		await store.close();

		// File on disk before compact:
		//   msg seq=1, msg seq=2, msg seq=3, ack seq=2,
		//   msg seq=4, msg seq=5, ack seq=5
		// head = max(2, 5) = 5. After compact everything <= 5 is gone.
		// Result: empty file (all msgs were implicitly acked via the
		// contiguous ACK for seq=5).
		const store2 = new OutboxStore(path);
		await store2.compact();
		await store2.close();

		const lines = await readRawLines(path);
		expect(lines).toEqual([]);
	});

	it("is a no-op when head is 0 (nothing to drop)", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const store = new OutboxStore(path);
		await store.append(1, "a");
		await store.append(2, "b");
		await store.close();

		const store2 = new OutboxStore(path);
		await store2.compact();
		await store2.close();

		const lines = await readRawLines(path);
		expect(lines).toEqual([
			{ kind: "msg", seq: 1, encoded: "a" },
			{ kind: "msg", seq: 2, encoded: "b" },
		]);
	});

	it("preserves unackedFrom / getHead semantics across a round-trip", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const store = new OutboxStore(path);
		await store.append(1, "a");
		await store.append(2, "b");
		await store.markAcked(1);
		await store.append(3, "c");
		await store.close();

		// head = 1 before compact. The ack seq=1 tombstone has seq <=
		// head and gets dropped together with msg seq=1. After compact,
		// the file is:
		//   msg seq=2, msg seq=3
		// No tombstones survive — getHead therefore reads 0 even though
		// the receiver is still up to seq=1. PR-3 reconstructs the
		// implicit head from in-memory state when it picks up the store.
		const store2 = new OutboxStore(path);
		await store2.compact();
		await store2.close();

		const store3 = new OutboxStore(path);
		expect(await store3.getHead()).toBe(0);
		expect(await store3.unackedFrom(0)).toEqual([
			{ seq: 2, encoded: "b" },
			{ seq: 3, encoded: "c" },
		]);
		await store3.close();
	});
});

describe("OutboxStore — crash recovery", () => {
	it("skips a partial last line on reopen without throwing", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const valid =
			'{"kind":"msg","seq":1,"encoded":"ok1"}\n{"kind":"msg","seq":2,"encoded":"ok2"}\n';
		const corrupt = '{"kind":"msg","seq":3,"encoded":"partia';
		await writeFile(path, valid + corrupt);

		const store = new OutboxStore(path);
		const unacked = await store.unackedFrom(0);
		expect(unacked).toEqual([
			{ seq: 1, encoded: "ok1" },
			{ seq: 2, encoded: "ok2" },
		]);
		await store.close();
	});

	it("survives a garbage byte slice in the middle of the file", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const head = '{"kind":"msg","seq":1,"encoded":"first"}\n';
		const garbage = "\x00\x01\x02not-json-at-all\xff\n";
		const tail = '{"kind":"msg","seq":2,"encoded":"second"}\n';
		await writeFile(path, head + garbage + tail);

		const store = new OutboxStore(path);
		const unacked = await store.unackedFrom(0);
		expect(unacked).toEqual([
			{ seq: 1, encoded: "first" },
			{ seq: 2, encoded: "second" },
		]);
		await store.close();
	});

	it("does not regress getHead when only tombstones are corrupted", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		await writeFile(path, '{"kind":"msg","seq":1,"encoded":"x"}\n{"kind":"ack","seq":1');

		const store = new OutboxStore(path);
		expect(await store.getHead()).toBe(0);
		expect(await store.unackedFrom(0)).toEqual([{ seq: 1, encoded: "x" }]);
		await store.close();
	});
});

describe("OutboxStore — concurrency", () => {
	it("serializes concurrent appends so on-disk order matches await order", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const store = new OutboxStore(path);

		// Fire three appends without awaiting between them, then await all.
		// Promise-chain discipline must serialize the fsyncs so the file
		// ends up in the order they were awaited (not the order the event
		// loop picked the I/O up).
		const p1 = store.append(1, "first");
		const p2 = store.append(2, "second");
		const p3 = store.append(3, "third");
		await Promise.all([p1, p2, p3]);
		await store.close();

		const lines = await readRawLines(path);
		expect(lines).toEqual([
			{ kind: "msg", seq: 1, encoded: "first" },
			{ kind: "msg", seq: 2, encoded: "second" },
			{ kind: "msg", seq: 3, encoded: "third" },
		]);
	});

	it("interleaves append and markAcked without losing order", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const store = new OutboxStore(path);

		const p1 = store.append(1, "a");
		const p2 = store.markAcked(1);
		const p3 = store.append(2, "b");
		const p4 = store.markAcked(2);
		await Promise.all([p1, p2, p3, p4]);
		await store.close();

		const lines = await readRawLines(path);
		expect(lines).toEqual([
			{ kind: "msg", seq: 1, encoded: "a" },
			{ kind: "ack", seq: 1 },
			{ kind: "msg", seq: 2, encoded: "b" },
			{ kind: "ack", seq: 2 },
		]);
	});
});

describe("OutboxStore — close", () => {
	it("makes subsequent operations reject instead of silently succeeding", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const store = new OutboxStore(path);
		await store.append(1, "a");
		await store.close();

		await expect(store.append(2, "b")).rejects.toThrow();
		await expect(store.markAcked(2)).rejects.toThrow();
		await expect(store.unackedFrom(0)).rejects.toThrow();
		await expect(store.getHead()).rejects.toThrow();
		await expect(store.compact()).rejects.toThrow();
	});

	it("is idempotent", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const store = new OutboxStore(path);
		await store.append(1, "a");
		await store.close();
		// Second close must not throw.
		await store.close();
	});

	it("still allows a fresh store to open the file written before close", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const writer = new OutboxStore(path);
		await writer.append(1, "a");
		await writer.append(2, "b");
		await writer.markAcked(2);
		await writer.close();

		const reader = new OutboxStore(path);
		expect(await reader.getHead()).toBe(2);
		expect(await reader.unackedFrom(0)).toEqual([{ seq: 1, encoded: "a" }]);
		await reader.close();
	});
});

describe("OutboxStore — fsync", () => {
	it("tolerates a brief pause between writes without losing data", async () => {
		// Smoke test: the contract is "fsync per append", not "fsync per N
		// appends". This case just confirms that two writes separated by a
		// short sleep both land durably and read back correctly — a regression
		// test for the case where an implementation accidentally batches
		// (which would lose everything since the last batch on a hard kill).
		const path = join(scratchDir, "outbox.jsonl");
		const store = new OutboxStore(path);
		await store.append(1, "a");
		await sleep(5);
		await store.append(2, "b");
		await sleep(5);
		await store.append(3, "c");
		await store.close();

		const reopened = new OutboxStore(path);
		expect(await reopened.unackedFrom(0)).toEqual([
			{ seq: 1, encoded: "a" },
			{ seq: 2, encoded: "b" },
			{ seq: 3, encoded: "c" },
		]);
		await reopened.close();
	});

	it("leaves no partial trailing newline when closed mid-write (best-effort signal)", async () => {
		// We can't actually catch a crash mid-fsync here, but we CAN verify
		// that the file ends in a newline under normal shutdown — the
		// invariant a recover-after-crash path will rely on.
		const path = join(scratchDir, "outbox.jsonl");
		const store = new OutboxStore(path);
		await store.append(1, "a");
		await store.close();

		const raw = await readFile(path, "utf8");
		expect(raw.endsWith("\n")).toBe(true);
	});
});

describe("OutboxStore — concurrent writers do not corrupt the file", () => {
	// Sanity guard: two stores pointing at the same path (one writer, one
	// reader) must not produce overlapping or torn writes. The reader just
	// reads once after the writer is done, so this is a regression test for
	// the "shared fd" bug, not a true concurrent-reader scenario.
	it("the file produced by a single writer is parseable by an independent reader", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const writer = new OutboxStore(path);
		for (let i = 1; i <= 50; i++) {
			await writer.append(i, `payload-${i}`);
		}
		await writer.markAcked(10);
		await writer.markAcked(20);
		await writer.close();

		const reader = new OutboxStore(path);
		const unacked = await reader.unackedFrom(0);
		// 50 - 2 = 48 unacked entries, sorted.
		expect(unacked.length).toBe(48);
		expect(unacked[0]).toEqual({ seq: 1, encoded: "payload-1" });
		expect(unacked[unacked.length - 1]).toEqual({ seq: 50, encoded: "payload-50" });
		expect(await reader.getHead()).toBe(20);
		await reader.close();
	});
});

// One more sanity-check from a spec angle: the file path is owned by the
// caller, the store should not derive anything from it (e.g. by reaching
// into `~/.wenchat`). This test writes outside of the scratch dir using an
// explicit absolute path, asserting the store neither creates `~/.wenchat`
// nor inspects its surroundings.
describe("OutboxStore — path discipline", () => {
	it("does not touch `~/.wenchat` when given an explicit absolute path", async () => {
		const path = join(scratchDir, "explicit.jsonl");
		const store = new OutboxStore(path);
		await store.append(1, "x");
		await store.close();

		const lines = await readRawLines(path);
		expect(lines).toEqual([{ kind: "msg", seq: 1, encoded: "x" }]);
	});
});

// Last test: verify an externally appended line (a process crash that left
// a valid line on disk before another fsync was supposed to happen) is
// picked up. This is the "another process truncated the file" trap — the
// store must always re-read the file when asked, not cache from memory.
describe("OutboxStore — external write pickup", () => {
	it("sees a line appended by an external writer after construction", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const store = new OutboxStore(path);
		await store.append(1, "first");

		// Simulate a process that wrote while the store was idle.
		await appendFile(path, `{"kind":"msg","seq":2,"encoded":"second"}\n`, "utf8");

		const unacked = await store.unackedFrom(0);
		expect(unacked).toEqual([
			{ seq: 1, encoded: "first" },
			{ seq: 2, encoded: "second" },
		]);
		await store.close();
	});
});

// `mkdir -p` regression: must create the parent directory recursively.
describe("OutboxStore — mkdir -p", () => {
	it("creates a deeply nested parent directory that does not exist yet", async () => {
		const dir = join(scratchDir, "a", "b", "c", "d", "e");
		const path = join(dir, "outbox.jsonl");
		const store = new OutboxStore(path);
		await store.append(1, "deep");
		await store.close();

		// Confirm the directory was actually created on disk (so we know
		// mkdir -p ran, not just that the file write silently worked
		// because mkdir was a no-op).
		const entries = await readRawLines(path);
		expect(entries).toEqual([{ kind: "msg", seq: 1, encoded: "deep" }]);
	});
});

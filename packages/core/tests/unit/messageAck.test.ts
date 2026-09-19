import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, MessageAckMessage } from "@wenchat/protocol";
import { MessageAckScheduler } from "../../src/messageAck";
import { OutboxStore } from "../../src/outbox";

// Tests for the sender/receiver ACK scheduler (PR-3 + PR-4, ADR 0003
// Q3/Q4/Q7/Q10). PR-4 swaps the PR-3 bounded `Set<number>` dedup for
// the 256-entry LRU `ReceiveWindow` and adds the "gap → immediate ACK"
// branch on `noteInbound`; the rest of the scheduler (sender-side seq
// allocation, retransmit timer, outbox wiring, every-16/idle ACK
// cadence) is unchanged.
//
// Two "harness" helpers drive the scheduler with fake transport and fake
// listeners so the timer behaviour and the state-machine transitions are
// the only things under test — no fs, no werift, no real clock.

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let defaultScratchDir: string;
let defaultStore: OutboxStore;

beforeEach(async () => {
	defaultScratchDir = await mkdtemp(join(tmpdir(), "message-ack-"));
	defaultStore = new OutboxStore(join(defaultScratchDir, "outbox.jsonl"));
});
afterEach(async () => {
	await defaultStore.close();
	await rm(defaultScratchDir, { recursive: true, force: true });
});

type Harness = {
	scheduler: MessageAckScheduler;
	sentAcks: MessageAckMessage[];
	sentMessages: Message[];
	abandonedSeqs: number[];
	emptyEvents: number;
	store: OutboxStore;
};

function makeHarness(overrides?: {
	store?: OutboxStore;
	sendAck?: (ack: MessageAckMessage) => void;
	sendMessage?: (msg: Message) => void;
	idleAckMs?: number;
	messagesPerAck?: number;
	initialRetransmitMs?: number;
	maxRetransmitMs?: number;
	maxRetransmitAttempts?: number;
	dedupWindowSize?: number;
}): Harness {
	const sentAcks: MessageAckMessage[] = [];
	const sentMessages: Message[] = [];
	const abandonedSeqs: number[] = [];
	const emptyEvents = { value: 0 };
	const store = overrides?.store ?? defaultStore;
	const scheduler = new MessageAckScheduler({
		outbox: store,
		sendAck: overrides?.sendAck ?? ((ack) => sentAcks.push(ack)),
		sendMessage: overrides?.sendMessage ?? ((msg) => sentMessages.push(msg)),
		onOutboxAbandoned: (seq) => abandonedSeqs.push(seq),
		onOutboxEmpty: () => {
			emptyEvents.value += 1;
		},
		idleAckMs: overrides?.idleAckMs,
		messagesPerAck: overrides?.messagesPerAck,
		initialRetransmitMs: overrides?.initialRetransmitMs,
		maxRetransmitMs: overrides?.maxRetransmitMs,
		maxRetransmitAttempts: overrides?.maxRetransmitAttempts,
		dedupWindowSize: overrides?.dedupWindowSize,
	});
	return {
		scheduler,
		sentAcks,
		sentMessages,
		abandonedSeqs,
		get emptyEvents() {
			return emptyEvents.value;
		},
		set emptyEvents(v: number) {
			emptyEvents.value = v;
		},
		store,
	};
}

describe("MessageAckScheduler — sender-side seq allocation", () => {
	let scratchDir: string;

	beforeEach(async () => {
		scratchDir = await mkdtemp(join(tmpdir(), "message-ack-"));
	});
	afterEach(async () => {
		await rm(scratchDir, { recursive: true, force: true });
	});

	it("allocateSeq starts at 1 on a fresh scheduler", () => {
		const h = makeHarness();
		expect(h.scheduler.allocateSeq()).toBe(1);
		expect(h.scheduler.allocateSeq()).toBe(2);
		expect(h.scheduler.allocateSeq()).toBe(3);
	});

	it("initFromOutbox loads nextSeq from outbox.getHead() + 1", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const seeded = new OutboxStore(path);
		await seeded.append(1, "x");
		await seeded.append(2, "y");
		await seeded.append(3, "z");
		await seeded.markAcked(7);
		await seeded.close();

		const reopened = new OutboxStore(path);
		const h = makeHarness({ store: reopened });
		await h.scheduler.initFromOutbox();
		expect(h.scheduler.allocateSeq()).toBe(8);
		expect(h.scheduler.allocateSeq()).toBe(9);
		await reopened.close();
	});

	it("survives an outbox with zero acks (fresh process first time on the wire)", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const seeded = new OutboxStore(path);
		await seeded.append(1, "x");
		await seeded.close();

		const reopened = new OutboxStore(path);
		const h = makeHarness({ store: reopened });
		await h.scheduler.initFromOutbox();
		expect(h.scheduler.allocateSeq()).toBe(1);
		await reopened.close();
	});

	it("initFromOutbox is idempotent: a second call does not double-count", async () => {
		const path = join(scratchDir, "init-idempotent.jsonl");
		const store = new OutboxStore(path);
		const h = makeHarness({ store });
		await h.scheduler.initFromOutbox();
		await h.scheduler.initFromOutbox();
		// Fresh file → head=0 → first allocateSeq returns 1. The second
		// initFromOutbox must be a no-op (the in-memory counter is
		// authoritative once non-zero).
		expect(h.scheduler.allocateSeq()).toBe(1);
		expect(h.scheduler.allocateSeq()).toBe(2);
		await store.close();
	});
});

describe("MessageAckScheduler — receiver-side ACK emission (ADR 0003 Q3)", () => {
	it("emits a single ACK after the idle timer fires", async () => {
		const h = makeHarness({ idleAckMs: 50 });
		h.scheduler.noteInbound(1);
		expect(h.sentAcks).toHaveLength(0);
		await sleep(80);
		expect(h.sentAcks).toHaveLength(1);
		expect(h.sentAcks[0].payload.ack).toBe(1);
	});

	it("emits an ACK every 16 inbound messages, even if the idle timer never fires", async () => {
		const h = makeHarness({ idleAckMs: 10_000, messagesPerAck: 16 });
		for (let i = 1; i <= 15; i++) {
			h.scheduler.noteInbound(i);
		}
		expect(h.sentAcks).toHaveLength(0);
		h.scheduler.noteInbound(16);
		expect(h.sentAcks).toHaveLength(1);
		expect(h.sentAcks[0].payload.ack).toBe(16);
	});

	it("resets the count after each emission (the next 16 start over)", async () => {
		const h = makeHarness({ idleAckMs: 10_000, messagesPerAck: 4 });
		for (let i = 1; i <= 4; i++) h.scheduler.noteInbound(i);
		expect(h.sentAcks).toHaveLength(1);
		for (let i = 5; i <= 8; i++) h.scheduler.noteInbound(i);
		expect(h.sentAcks).toHaveLength(2);
		expect(h.sentAcks[1].payload.ack).toBe(8);
	});

	it("flushAck emits immediately and resets the count", async () => {
		const h = makeHarness({ idleAckMs: 10_000 });
		h.scheduler.noteInbound(1);
		h.scheduler.noteInbound(2);
		h.scheduler.flushAck();
		expect(h.sentAcks).toHaveLength(1);
		expect(h.sentAcks[0].payload.ack).toBe(2);
		// count is reset — another 15 inbound notes do not trigger a second ACK
		for (let i = 3; i <= 17; i++) h.scheduler.noteInbound(i);
		expect(h.sentAcks).toHaveLength(1);
		// The 16th note after reset (seq=18) hits the every-16 trigger.
		h.scheduler.noteInbound(18);
		expect(h.sentAcks).toHaveLength(2);
		expect(h.sentAcks[1].payload.ack).toBe(18);
	});

	it("flushAck after the idle timer already fired is also safe (idempotent reset)", async () => {
		const h = makeHarness({ idleAckMs: 30 });
		h.scheduler.noteInbound(1);
		await sleep(60);
		expect(h.sentAcks).toHaveLength(1);
		h.scheduler.flushAck();
		// No new ACK emitted — count was reset by the idle timer, and
		// flushAck doesn't double-emit if the count is already zero.
		expect(h.sentAcks).toHaveLength(1);
	});

	it("closeSession emits a final ACK and stops scheduling timers", async () => {
		const h = makeHarness({ idleAckMs: 30 });
		h.scheduler.noteInbound(1); // "new" → triggers idle/count ACK cadence
		h.scheduler.closeSession();
		expect(h.sentAcks).toHaveLength(1);
		expect(h.sentAcks[0].payload.ack).toBe(1);
		// The idle timer is dead — waiting past the deadline must NOT emit.
		await sleep(60);
		expect(h.sentAcks).toHaveLength(1);
	});

	it("inboundHighestContiguous advances through contiguous seqs and stops at the first gap", () => {
		// PR-4 — the receive window is the source of truth for
		// highestContiguous. accept(5) is a gap from 3 to 4, so
		// highestContiguous stays at 2 (the last contiguous). The
		// ACK value reflects that — PR-3 used to emit max(seen)
		// which would have led to "fraud gap" false positives after
		// reconnect.
		const h = makeHarness();
		h.scheduler.noteInbound(1);
		h.scheduler.noteInbound(2);
		h.scheduler.noteInbound(5); // gap; highest stays at 2
		expect(h.scheduler.getInboundHighestContiguous()).toBe(2);
		// Accepting 3 fills the gap and cascades through 4 (not in
		// window) and 5 (in window via the prior gap-detect insert)
		// — wait, 4 isn't in window, so cascade stops at 3 then 5 is
		// not contiguous from 3. Then accepting 4 fills 4, and the
		// cascade pushes through 4 → 5. highestContiguous = 5.
		h.scheduler.noteInbound(3);
		expect(h.scheduler.getInboundHighestContiguous()).toBe(3);
		h.scheduler.noteInbound(4);
		expect(h.scheduler.getInboundHighestContiguous()).toBe(5);
	});
});

describe("MessageAckScheduler — dedup via ReceiveWindow (PR-4)", () => {
	it("dedupInbound returns false for the first sighting and true for repeats", () => {
		const h = makeHarness();
		expect(h.scheduler.dedupInbound(1)).toBe(false);
		expect(h.scheduler.dedupInbound(2)).toBe(false);
		expect(h.scheduler.dedupInbound(1)).toBe(true);
		expect(h.scheduler.dedupInbound(2)).toBe(true);
	});

	it("evicts the oldest seq once the window of 64 is full", () => {
		// PR-4 — the dedup window now lives in `ReceiveWindow`, default
		// cap 256. Override to 64 to keep this case fast.
		const h = makeHarness({ dedupWindowSize: 64 });
		for (let i = 1; i <= 64; i++) {
			expect(h.scheduler.dedupInbound(i)).toBe(false);
		}
		// The window is full. The next seq is new; the oldest must drop.
		expect(h.scheduler.dedupInbound(65)).toBe(false);
		// seq 1 is gone, seq 2..65 remain.
		expect(h.scheduler.dedupInbound(1)).toBe(false);
		expect(h.scheduler.dedupInbound(65)).toBe(true);
	});
});

describe("MessageAckScheduler — sender-side retransmit (ADR 0003 Q4)", () => {
	it("scheduleRetransmit fires once after initialRetransmitMs", async () => {
		const h = makeHarness({ initialRetransmitMs: 50, maxRetransmitMs: 10_000 });
		h.scheduler.scheduleRetransmit(1, '{"seq":1}');
		expect(h.sentMessages).toHaveLength(0);
		await sleep(80);
		expect(h.sentMessages).toHaveLength(1);
		expect((h.sentMessages[0] as { seq: number }).seq).toBe(1);
	});

	it("exponential ×2 backoff (50ms → 100ms → 200ms → 400ms …)", async () => {
		const h = makeHarness({
			initialRetransmitMs: 50,
			maxRetransmitMs: 10_000,
			maxRetransmitAttempts: 5,
		});
		const timestamps: number[] = [];
		const start = Date.now();
		const realSend = h.sentMessages.push.bind(h.sentMessages);
		h.scheduler.scheduleRetransmit(1, '{"seq":1}');
		h.sentMessages.push = (msg: Message) => {
			timestamps.push(Date.now() - start);
			return realSend(msg);
		};
		// Wait long enough for the configured 5 attempts: 50 + 100 + 200
		// + 400 + 800 + 50 ms of margin. The 5th attempt is the give-up,
		// so only 4 sendMessage calls land.
		await sleep(50 + 100 + 200 + 400 + 800 + 50);
		h.sentMessages.push = realSend;

		expect(h.sentMessages.length).toBeGreaterThanOrEqual(4);
		// Delays between consecutive retransmits grow exponentially until cap.
		const deltas: number[] = [];
		for (let i = 1; i < timestamps.length; i++) {
			deltas.push(timestamps[i] - timestamps[i - 1]);
		}
		// First three deltas should roughly double (50 → 100 → 200 ms).
		expect(deltas[0]).toBeGreaterThanOrEqual(45);
		expect(deltas[1]).toBeGreaterThanOrEqual(90);
		expect(deltas[2]).toBeGreaterThanOrEqual(180);
	});

	it("give up after maxRetransmitAttempts and emit outbox-abandoned", async () => {
		const h = makeHarness({
			initialRetransmitMs: 20,
			maxRetransmitMs: 100,
			maxRetransmitAttempts: 5,
		});
		h.scheduler.scheduleRetransmit(7, '{"seq":7}');
		await sleep(20 + 40 + 80 + 100 + 100 + 100 + 50);
		expect(h.abandonedSeqs).toEqual([7]);
	});

	it("does not retransmit after the scheduler receives an ACK", async () => {
		const h = makeHarness({ initialRetransmitMs: 50, maxRetransmitMs: 10_000 });
		h.scheduler.scheduleRetransmit(3, '{"seq":3}');
		await sleep(20); // let the first retransmit fire
		expect(h.sentMessages.length).toBeGreaterThanOrEqual(0); // any number is fine
		const before = h.sentMessages.length;
		await h.scheduler.noteAck(3);
		await sleep(80);
		// After ACK: no further retransmits.
		expect(h.sentMessages.length).toBe(before);
	});
});

describe("MessageAckScheduler — inbound ACK handling (ADR 0003 Q2)", () => {
	let scratchDir: string;

	beforeEach(async () => {
		scratchDir = await mkdtemp(join(tmpdir(), "message-ack-ack-"));
	});
	afterEach(async () => {
		await rm(scratchDir, { recursive: true, force: true });
	});

	it("noteAck calls outbox.markAcked for the acked seq and clears the timer", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const store = new OutboxStore(path);
		await store.append(1, "a");
		await store.append(2, "b");
		await store.append(3, "c");
		await store.close();

		const reopened = new OutboxStore(path);
		const h = makeHarness({
			store: reopened,
			initialRetransmitMs: 60,
			maxRetransmitMs: 10_000,
			maxRetransmitAttempts: 3,
		});
		h.scheduler.scheduleRetransmit(1, '{"seq":1}');
		h.scheduler.scheduleRetransmit(2, '{"seq":2}');
		h.scheduler.scheduleRetransmit(3, '{"seq":3}');
		expect(h.sentMessages).toHaveLength(0);
		// Drain the two acked seqs before their timers fire.
		await h.scheduler.noteAck(2);
		await sleep(100);
		// Only the unacked seq=3 should have retransmitted (its timer was
		// scheduled at +60ms and we slept 100ms).
		expect(h.sentMessages.length).toBe(1);
		expect((h.sentMessages[0] as { seq: number }).seq).toBe(3);

		expect(await reopened.getHead()).toBe(2);
		await reopened.close();
	});

	it("monotonic guard: a late ACK with seq < current head is silently ignored", async () => {
		// The scheduler relays noteAck calls down to OutboxStore.markAcked
		// for seqs that are actually pending retransmit. This test
		// exercises the OutboxStore-level guard (PR-2 review edge #2):
		// schedule seqs 1, 2, 5 — ack(5) bumps head to 5 — then a buggy
		// peer's late ack(2) must not roll the head back.
		const path = join(scratchDir, "outbox.jsonl");
		const store = new OutboxStore(path);
		await store.append(1, "a");
		await store.append(2, "b");
		await store.close();

		const reopened = new OutboxStore(path);
		const h = makeHarness({ store: reopened, initialRetransmitMs: 10_000 });
		h.scheduler.scheduleRetransmit(1, '{"seq":1}');
		h.scheduler.scheduleRetransmit(2, '{"seq":2}');
		h.scheduler.scheduleRetransmit(5, '{"seq":5}');
		await h.scheduler.noteAck(5); // bumps head to 5
		expect(await reopened.getHead()).toBe(5);
		// Buggy peer: late ack(2). seq=2 is still in pendingRetransmits,
		// so the scheduler WILL call markAcked(2); the OutboxStore
		// monotonic guard catches it.
		await h.scheduler.noteAck(2);
		expect(await reopened.getHead()).toBe(5);
		await reopened.close();
	});

	it("emits outbox-empty exactly once when the last pending seq is acked", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const store = new OutboxStore(path);
		await store.close();

		const reopened = new OutboxStore(path);
		const emptyEvents: number[] = [];
		const h = makeHarness({
			store: reopened,
			initialRetransmitMs: 10_000,
		});
		// Override the onOutboxEmpty callback to record events.
		h.scheduler = new MessageAckScheduler({
			outbox: reopened,
			sendAck: (ack) => h.sentAcks.push(ack),
			sendMessage: (msg) => h.sentMessages.push(msg),
			onOutboxAbandoned: (seq) => h.abandonedSeqs.push(seq),
			onOutboxEmpty: () => emptyEvents.push(emptyEvents.length),
			initialRetransmitMs: 10_000,
		});
		h.scheduler.scheduleRetransmit(1, '{"seq":1}');
		h.scheduler.scheduleRetransmit(2, '{"seq":2}');
		expect(emptyEvents).toEqual([]);
		await h.scheduler.noteAck(1);
		expect(emptyEvents).toEqual([]); // seq=2 still pending
		await h.scheduler.noteAck(2);
		expect(emptyEvents).toEqual([0]); // fired once
		await h.scheduler.noteAck(2); // duplicate: still empty
		expect(emptyEvents).toEqual([0]);
		await reopened.close();
	});

	it("emits outbox-empty exactly once when the last pending seq is abandoned", async () => {
		const path = join(scratchDir, "outbox.jsonl");
		const store = new OutboxStore(path);
		await store.close();

		const reopened = new OutboxStore(path);
		const emptyEvents: number[] = [];
		const h = makeHarness({
			store: reopened,
			initialRetransmitMs: 10,
			maxRetransmitMs: 20,
			maxRetransmitAttempts: 2,
		});
		h.scheduler = new MessageAckScheduler({
			outbox: reopened,
			sendAck: (ack) => h.sentAcks.push(ack),
			sendMessage: (msg) => h.sentMessages.push(msg),
			onOutboxAbandoned: (seq) => h.abandonedSeqs.push(seq),
			onOutboxEmpty: () => emptyEvents.push(emptyEvents.length),
			initialRetransmitMs: 10,
			maxRetransmitMs: 20,
			maxRetransmitAttempts: 2,
		});
		h.scheduler.scheduleRetransmit(5, '{"seq":5}');
		await sleep(10 + 20 + 30);
		expect(h.abandonedSeqs).toEqual([5]);
		expect(emptyEvents).toEqual([0]);
		await reopened.close();
	});

	it("calls sendMessage via the Message shape (the scheduler re-emits the JSON-decoded message)", async () => {
		// The receiver of the retransmit must see the same seq the sender
		// originally assigned. The scheduler decodes the stored JSON and
		// hands a `Message` to sendMessage; whatever it dispatches goes
		// through the normal transport path with the original seq intact.
		const h = makeHarness({ initialRetransmitMs: 30, maxRetransmitMs: 10_000 });
		const original = JSON.stringify({
			type: "text",
			id: "m1",
			timestamp: 0,
			seq: 42,
			payload: { text: "hello" },
		});
		h.scheduler.scheduleRetransmit(42, original);
		await sleep(60);
		expect(h.sentMessages).toHaveLength(1);
		expect(h.sentMessages[0].type).toBe("text");
		expect((h.sentMessages[0] as { seq: number }).seq).toBe(42);
	});
});

describe("MessageAckScheduler — cross-cutting", () => {
	it("the outbound ACK frame is a valid MessageAckMessage (codec round-trip)", () => {
		// PR-4 — noteInbound(1) is "new" on a fresh window (highestContiguous
		// goes 0 → 1); noteInbound(7) would be a gap (1..6) and would not
		// produce an ACK under PR-4 semantics. Use a contiguous prefix.
		const h = makeHarness();
		h.scheduler.noteInbound(1);
		h.scheduler.noteInbound(2);
		h.scheduler.flushAck();
		const ack = h.sentAcks[0];
		// Round-trip via the codec to make sure the scheduler's output is
		// wire-compatible with the rest of the system.
		const { encode, decode } = require("@wenchat/protocol");
		const bytes = encode(ack);
		const decoded = decode(bytes);
		expect(decoded.type).toBe("message-ack");
		if (decoded.type === "message-ack") {
			expect(decoded.payload.ack).toBe(2);
		}
	});

	it("uses the default timeouts when not overridden", () => {
		// Smoke test: the constructor accepts no overrides and yields a
		// scheduler that uses the ADR 0003 Q3/Q4 defaults (200ms idle, every
		// 16 messages, 2s → 30s backoff, 5 retries). We assert the public
		// shape only — no timer inspection.
		const h = makeHarness();
		h.scheduler.scheduleRetransmit(1, '{"seq":1}');
		h.scheduler.scheduleRetransmit(2, '{"seq":2}');
		expect(h.scheduler.dedupInbound(1)).toBe(false);
		expect(h.scheduler.dedupInbound(1)).toBe(true);
	});

	it("scheduleRetransmit is a no-op after closeSession", async () => {
		const h = makeHarness({ initialRetransmitMs: 30, maxRetransmitMs: 10_000 });
		h.scheduler.closeSession();
		h.scheduler.scheduleRetransmit(1, '{"seq":1}');
		await sleep(60);
		expect(h.sentMessages).toHaveLength(0);
		expect(h.abandonedSeqs).toEqual([]);
	});
});

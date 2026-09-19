import type { Message, MessageAckMessage } from "@wenchat/protocol";
import { createMessageAck } from "@wenchat/protocol";
import { getLogger } from "./logger";
import type { OutboxStore } from "./outbox";
import { ReceiveWindow } from "./receiveWindow";

// PR-3 + PR-4 — MessageAckScheduler (ADR 0003 Q3, Q4, Q7, Q10).
//
// One scheduler per `PeerConnection`. Two roles that share state:
//
//  * Sender — allocates a monotonic seq to every outbound application
//    message, persists it via `OutboxStore.append`, schedules a
//    per-message retransmit timer, and clears the timer on inbound ACK.
//  * Receiver — runs every inbound `seq` through a 256-entry LRU
//    `ReceiveWindow` (PR-4, Q7): the window dedups, emits an
//    immediate ACK when a gap is detected, and reports the highest
//    contiguous seq received. ACKs are also emitted on whichever hits
//    first of: 200 ms idle, every 16 inbound messages, or session
//    close (Q3).
//
// The scheduler is intentionally IO-free in its hot path. The only async
// work is the outbox `markAcked` calls (fire-and-forget — a failed fsync
// on an ack tombstone is recoverable; the sender will retransmit) and the
// timer-driven retransmit, which is a `sendMessage` call that dispatches
// via the current transport (the peer.ts wrapper takes care of picking
// the live Session).

/** ADR 0003 Q3 — ACK trigger: 200 ms idle timer. */
const IDLE_ACK_MS = 200;
/** ADR 0003 Q3 — ACK trigger: every 16 inbound messages. */
const MESSAGES_PER_ACK = 16;
/** ADR 0003 Q4 — initial retransmit delay. */
const INITIAL_RETRANSMIT_MS = 2_000;
/** ADR 0003 Q4 — exponential ×2 backoff cap. */
const MAX_RETRANSMIT_MS = 30_000;
/** ADR 0003 Q4 — give up after this many attempts. */
const MAX_RETRANSMIT_ATTEMPTS = 5;
/** ADR 0003 Q4 — backoff factor. */
const RETRANSMIT_BACKOFF_FACTOR = 2;

/** ADR 0003 Q7 — receive-window cap. Tests may pass a smaller value via
 *  `MessageAckSchedulerOptions.dedupWindowSize` to keep eviction cases
 *  fast. */
const DEFAULT_DEDUP_WINDOW_SIZE = 256;

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export type MessageAckSchedulerOptions = {
	outbox: OutboxStore;
	/** Called when the scheduler wants to emit a `message-ack` on the wire. */
	sendAck: (ack: MessageAckMessage) => void;
	/** Called when a per-message retransmit fires. The scheduler hands back
	 *  the JSON-decoded original message — the caller re-encodes it on the
	 *  normal send path so the same seq survives the round trip. */
	sendMessage: (msg: Message) => void;
	/** Fires once per seq whose 5-attempt retry budget is exhausted
	 *  (ADR 0003 Q4). The CLI surfaces this as a system message in PR-6. */
	onOutboxAbandoned: (seq: number) => void;
	/** Fires exactly once per outbox-empty transition (see note in
	 *  `noteAck`). */
	onOutboxEmpty: () => void;
	/** PR-4 — provide an explicit `ReceiveWindow` to use as the
	 *  receiver-side dedup + gap-detector. Optional: when omitted, a
	 *  fresh `ReceiveWindow` is constructed with `dedupWindowSize`
	 *  (default 256, ADR 0003 Q7). Callers that want to share or
	 *  inspect the window (none today) pass it explicitly. */
	receiveWindow?: ReceiveWindow;
	/** PR-4 — receive-window cap. Used only when `receiveWindow` is
	 *  omitted; tests pass a smaller value to keep eviction cases
	 *  fast. Default: 256. */
	dedupWindowSize?: number;
	/** Override the cadence / backoff numbers for tests. */
	idleAckMs?: number;
	messagesPerAck?: number;
	initialRetransmitMs?: number;
	maxRetransmitMs?: number;
	maxRetransmitAttempts?: number;
	retransmitBackoffFactor?: number;
};

type PendingRetransmit = {
	encoded: string;
	attempts: number;
	timer: ReturnType<typeof setTimeout>;
	nextDelayMs: number;
};

/**
 * Per-peer monotonic ACK scheduler. Constructed once per `PeerConnection`
 * and reused across `swapSession` (the seq counter, retransmit timers,
 * and receiver state all survive a transport swap — only the
 * `sendAck` / `sendMessage` callbacks are re-pointed at the new session).
 */
export class MessageAckScheduler {
	private readonly outbox: OutboxStore;
	private readonly sendAck: (ack: MessageAckMessage) => void;
	private readonly sendMessage: (msg: Message) => void;
	private readonly onOutboxAbandoned: (seq: number) => void;
	private readonly onOutboxEmpty: () => void;

	private readonly idleAckMs: number;
	private readonly messagesPerAck: number;
	private readonly initialRetransmitMs: number;
	private readonly maxRetransmitMs: number;
	private readonly maxRetransmitAttempts: number;
	private readonly retransmitBackoffFactor: number;

	// Sender state.
	private nextSeq = 0;
	private readonly pendingRetransmits = new Map<number, PendingRetransmit>();
	// Tracks whether we have any in-flight retransmits or known-unacked
	// entries. Used to decide when to emit `outbox-empty` (exactly once
	// per transition from non-empty to empty). Distinct from
	// `pendingRetransmits.size` so a flush-ack that drops every pending
	// entry but doesn't yet know the outbox is empty can still fire the
	// event — the flag is the source of truth.
	private outboxNonEmpty = false;

	// Receiver state.
	// PR-4 — the receive window owns dedup, gap detection, and the
	// highestContiguous counter. The scheduler's only receiver-side
	// concerns left are the ACK cadence (idle timer + every-N counter)
	// and the session-close flush.
	private readonly receiveWindow: ReceiveWindow;
	private inboundCountSinceLastAck = 0;
	private idleAckTimer: ReturnType<typeof setTimeout> | null = null;

	private closed = false;

	constructor(options: MessageAckSchedulerOptions) {
		this.outbox = options.outbox;
		this.sendAck = options.sendAck;
		this.sendMessage = options.sendMessage;
		this.onOutboxAbandoned = options.onOutboxAbandoned;
		this.onOutboxEmpty = options.onOutboxEmpty;
		this.receiveWindow =
			options.receiveWindow ??
			new ReceiveWindow(options.dedupWindowSize ?? DEFAULT_DEDUP_WINDOW_SIZE);
		this.idleAckMs = options.idleAckMs ?? IDLE_ACK_MS;
		this.messagesPerAck = options.messagesPerAck ?? MESSAGES_PER_ACK;
		this.initialRetransmitMs = options.initialRetransmitMs ?? INITIAL_RETRANSMIT_MS;
		this.maxRetransmitMs = options.maxRetransmitMs ?? MAX_RETRANSMIT_MS;
		this.maxRetransmitAttempts = options.maxRetransmitAttempts ?? MAX_RETRANSMIT_ATTEMPTS;
		this.retransmitBackoffFactor = options.retransmitBackoffFactor ?? RETRANSMIT_BACKOFF_FACTOR;
	}

	/**
	 * Seed the sender-side seq counter from the persisted outbox head.
	 * Caller MUST invoke this once after construction, BEFORE the first
	 * `allocateSeq`, so a fresh process picks up where the previous one
	 * left off (ADR 0003 Q10 — `seq` survives reconnect via outbox).
	 *
	 * Idempotent: a second call does not re-seed the counter — once we've
	 * started allocating, the in-memory value is authoritative.
	 */
	async initFromOutbox(): Promise<void> {
		if (this.nextSeq > 0) return;
		const head = await this.outbox.getHead();
		this.nextSeq = head;
	}

	/**
	 * Allocate the next monotonic seq. Sender-side only. Caller writes the
	 * outbox row and calls `scheduleRetransmit` with the same seq.
	 *
	 * Note: the seq starts at 1 (not 0) — `head` is the highest acked,
	 * `head + 1` is the next one to send, and a fresh process on first
	 * send after initFromOutbox with no prior history starts at 1.
	 */
	allocateSeq(): number {
		this.nextSeq += 1;
		return this.nextSeq;
	}

	/**
	 * Register a just-sent message for retransmit tracking. Each
	 * scheduled message has its own timer; receiving an ACK clears the
	 * timer + drops the entry + tombstone-writes via `outbox.markAcked`.
	 *
	 * `encoded` is the JSON wire payload — the scheduler re-emits the
	 * SAME bytes on retransmit so the receiver sees the original `seq`
	 * (its dedup catches anything it shouldn't re-deliver).
	 */
	scheduleRetransmit(seq: number, encoded: string): void {
		if (this.closed) return;
		const timer = setTimeout(() => {
			this.fireRetransmit(seq);
		}, this.initialRetransmitMs);
		this.pendingRetransmits.set(seq, {
			encoded,
			attempts: 0,
			timer,
			nextDelayMs: this.initialRetransmitMs,
		});
		this.outboxNonEmpty = true;
	}

	/**
	 * Process an inbound message-ack frame. The receiver's ACK value is
	 * "highest contiguous received" (ADR 0003 Q2), so every pending
	 * entry with `seq <= ack` is done — clear its timer, drop it from the
	 * map, and tell the outbox to tombstone it. The monotonic guard lives
	 * inside `OutboxStore.markAcked` (PR-2 review edge #2), so a late or
	 * reordered ACK is harmless here.
	 *
	 * Returns a promise that resolves when every `markAcked` has flushed.
	 * The hot-path caller (peer.ts) fires-and-forgets; tests await to
	 * observe deterministic head state. A failed fsync on an ack
	 * tombstone is recoverable: the sender will retransmit on the next
	 * idle-window and the receiver (or a fresh process) will ack again.
	 * We log the failure rather than let it propagate.
	 *
	 * `outbox-empty` fires once per drain transition. The flag
	 * (`outboxNonEmpty`) is the source of truth — even if a stray
	 * retransmit clears itself between this noteAck's two passes, the
	 * transition still emits at most once.
	 */
	async noteAck(ack: number): Promise<void> {
		if (this.closed) return;
		const drained: Array<Promise<void>> = [];
		for (const [seq, pending] of [...this.pendingRetransmits]) {
			if (seq > ack) continue;
			clearTimeout(pending.timer);
			this.pendingRetransmits.delete(seq);
			drained.push(this.outbox.markAcked(seq));
		}
		const results = await Promise.allSettled(drained);
		for (const result of results) {
			if (result.status === "rejected") {
				getLogger().warn(
					{ err: errorText(result.reason) },
					"outbox.markAcked failed (will retry on next ACK)",
				);
			}
		}
		this.checkOutboxEmpty();
	}

	/**
	 * Receiver-side: record one inbound seq. Returns the disposition:
	 *
	 *   * `"new"`       — first sighting within the window; caller
	 *                     forwards the message to user listeners.
	 *   * `"duplicate"` — already in the window; caller drops silently.
	 *   * `"gap"`       — `seq > highestContiguous + 1`; caller fires
	 *                     an immediate `message-ack` so the sender's
	 *                     retransmit timer can fill the hole. The
	 *                     scheduler also flushes an ACK itself here
	 *                     (the "gap detected → immediate ACK" path
	 *                     from ADR 0003 Q7 / implementation plan §B.2).
	 *
	 * Implementation note: the `ReceiveWindow` is the source of truth
	 * for `highestContiguous` (PR-4). This method is responsible only
	 * for the ACK-cadence bookkeeping.
	 */
	noteInbound(seq: number): "new" | "duplicate" | "gap" {
		const result = this.receiveWindow.accept(seq);
		if (result.status === "duplicate") {
			return "duplicate";
		}
		if (result.status === "gap") {
			// Gap detected → flush an immediate ACK. The sender's
			// existing PR-3 retransmit timer will cover the hole.
			// `flushAck` is a no-op when there's nothing new to
			// report (`inboundCountSinceLastAck === 0`) and will not
			// double-emit in that case.
			this.flushAck();
			return "gap";
		}
		// "new" — first sighting within the window.
		this.inboundCountSinceLastAck += 1;
		if (this.inboundCountSinceLastAck >= this.messagesPerAck) {
			this.flushAck();
		} else {
			this.scheduleIdleAck();
		}
		return "new";
	}

	/**
	 * Receiver-side: dedup gate. Exposed for callers that want the
	 * dedup check without involving the ACK cadence. A `gap` result
	 * is NOT a duplicate — the seq is in fact new (we just saw a
	 * hole), so `dedupInbound` only returns true when the seq is
	 * already in the LRU.
	 */
	dedupInbound(seq: number): boolean {
		return this.noteInbound(seq) === "duplicate";
	}

	/**
	 * Receiver-side: emit an ACK right now. Used by the "gap detected,
	 * immediately flush ACK" path (`noteInbound` calls this on a `"gap"`
	 * status) and by `closeSession` for the final-on-teardown emit.
	 *
	 * Idempotent in the sense that a count-already-zero call is a
	 * no-op — the existing ACK (if any) is the latest one and we don't
	 * re-emit just because the count happened to land on zero.
	 */
	flushAck(): void {
		if (this.closed) return;
		this.clearIdleAck();
		if (this.inboundCountSinceLastAck === 0) return;
		this.inboundCountSinceLastAck = 0;
		try {
			this.sendAck(createMessageAck(this.receiveWindow.getHighestContiguous()));
		} catch (err) {
			getLogger().warn(
				{ err: errorText(err), ack: this.receiveWindow.getHighestContiguous() },
				"sendAck threw",
			);
		}
	}

	/**
	 * Receiver-side: session is closing — emit one final ACK so the
	 * peer has the latest progress recorded, then stop scheduling. After
	 * this call the scheduler is dormant: no more idle timers, no more
	 * retransmits, no more outbound ACKs.
	 *
	 * PR-4 — also clear the receive window. A subsequent session
	 * (or the same session after a reconnect to a different peer) must
	 * NOT inherit stale dedup state; the LRU would otherwise mis-mark
	 * fresh inbound seqs as duplicates.
	 */
	closeSession(): void {
		if (this.closed) return;
		this.flushAck();
		this.closed = true;
		this.clearIdleAck();
		this.clearAllRetransmits();
		this.receiveWindow.clear();
	}

	/** Receiver-side: read-only view for tests and the CLI integration.
	 *  Delegates to the `ReceiveWindow` (PR-4). */
	getInboundHighestContiguous(): number {
		return this.receiveWindow.getHighestContiguous();
	}

	/**
	 * Sender-side: how many messages are waiting for an ACK right now.
	 * Zero means "the outbox is fully drained"; non-zero means there are
	 * in-flight retransmits the scheduler is still tracking. Exposed for
	 * the CLI's reliability UI (future) and the integration test's
	 * drain-to-zero assertions.
	 */
	pendingCount(): number {
		return this.pendingRetransmits.size;
	}

	private fireRetransmit(seq: number): void {
		const pending = this.pendingRetransmits.get(seq);
		if (!pending) return;
		pending.attempts += 1;
		if (pending.attempts >= this.maxRetransmitAttempts) {
			clearTimeout(pending.timer);
			this.pendingRetransmits.delete(seq);
			this.onOutboxAbandoned(seq);
			this.checkOutboxEmpty();
			return;
		}
		// Re-emit the original bytes. `JSON.parse` on our own encoded
		// payload is safe by construction (we encoded it before storing
		// it); we trust the encoder and skip a codec round-trip here.
		let msg: Message;
		try {
			msg = JSON.parse(pending.encoded) as Message;
		} catch (err) {
			// Should be impossible: we encoded it ourselves. Log and drop
			// the entry rather than throw into the timer callback.
			clearTimeout(pending.timer);
			this.pendingRetransmits.delete(seq);
			getLogger().error(
				{ err: errorText(err), seq },
				"retransmit: failed to decode stored payload — abandoning",
			);
			this.onOutboxAbandoned(seq);
			this.checkOutboxEmpty();
			return;
		}
		try {
			this.sendMessage(msg);
		} catch (err) {
			getLogger().warn({ err: errorText(err), seq }, "retransmit: sendMessage threw");
		}
		const nextDelay = Math.min(
			pending.nextDelayMs * this.retransmitBackoffFactor,
			this.maxRetransmitMs,
		);
		pending.nextDelayMs = nextDelay;
		pending.timer = setTimeout(() => {
			this.fireRetransmit(seq);
		}, nextDelay);
	}

	private scheduleIdleAck(): void {
		if (this.idleAckTimer !== null) return;
		this.idleAckTimer = setTimeout(() => {
			this.idleAckTimer = null;
			this.flushAck();
		}, this.idleAckMs);
	}

	private clearIdleAck(): void {
		if (this.idleAckTimer === null) return;
		clearTimeout(this.idleAckTimer);
		this.idleAckTimer = null;
	}

	private clearAllRetransmits(): void {
		for (const pending of this.pendingRetransmits.values()) {
			clearTimeout(pending.timer);
		}
		this.pendingRetransmits.clear();
	}

	private checkOutboxEmpty(): void {
		if (this.outboxNonEmpty && this.pendingRetransmits.size === 0) {
			this.outboxNonEmpty = false;
			this.onOutboxEmpty();
		}
	}
}

// PR-4 — Receiver-side dedup + gap detector (ADR 0003 Q7).
//
// One `ReceiveWindow` per remote peer, owned by `MessageAckScheduler` and
// reused across `swapSession` (ADR 0003 Q10). The window:
//
//   * Records every seq we have observed and remembers the highest
//     contiguous one — the value the receiver emits on every
//     `MessageAck` frame (Q2).
//   * Returns one of three dispositions per `accept`:
//       - "new"       — first sighting within the window; the caller
//                       forwards the message to user listeners and
//                       either advances `highestContiguous` (when
//                       `seq === highestContiguous + 1`) or notes a
//                       re-sight (when `seq <= highestContiguous` — the
//                       seq was already past contiguity but had been
//                       LRU-evicted, so it's "new to the window" but
//                       not new to the receiver).
//       - "duplicate" — already in the LRU; the caller drops silently.
//       - "gap"       — `seq > highestContiguous + 1`; the caller fires
//                       an immediate `message-ack` so the sender's
//                       retransmit timer can fill the hole. `gapFrom`
//                       is `highestContiguous + 1`; `gapTo` is
//                       `seq - 1`. The window does NOT advance
//                       `highestContiguous` here — we are still missing
//                       everything in `gapFrom..gapTo`.
//   * Evicts the oldest entry when full (LRU). With the default cap of
//     256 (Q7), the worst case for a chat session is "bursty duplication
//     after reconnect"; 256 is roughly a full backscroll of duplicates
//     before eviction starts losing dedup. Eviction is silent: the
//     `seq` is forgotten, and the next inbound sighting of it is
//     "new" (re-sight).
//
// Implementation notes
// --------------------
//
// * We use a `Map<number, true>` rather than a `Set<number>` because Map
//   iteration order is well-defined (insertion order) and `delete` +
//   `set` give us O(1) amortized LRU ops. The `true` value is
//   vestigial — only the key matters.
// * Duplicates do NOT refresh the entry's LRU position. Refreshing on
//   every "duplicate" hit would mask eviction behaviour (the entry
//   would never be the oldest), and the only thing the LRU position
//   drives is eviction order — irrelevant once the seq is in the set.
// * Gap fill is a CASCADE: when an accept advances `highestContiguous`
//   by one step, we keep advancing as long as `highestContiguous + 1`
//   is already in the window. Without the cascade, a re-arrival of an
//   out-of-order seq would leave the ACK value lagging behind what we
//   actually hold — the sender would then retransmit a seq we already
//   have. With the cascade, the ACK reflects reality after every
//   accept.

/**
 * ADR 0003 Q7 — the LRU cap. 256 entries are "roughly a full backscroll
 * of duplicates before eviction starts losing dedup".
 *
 * `ReceiveWindow` callers may pass a smaller cap for fast tests; the
 * default is the production value.
 */
export const DEFAULT_RECEIVE_WINDOW_CAP = 256;

/**
 * Per-peer observation of inbound `seq` values. Created once per peer
 * and reused across `swapSession` (Q10).
 */
export type AcceptResult =
	| { status: "new" }
	| { status: "duplicate" }
	| { status: "gap"; gapFrom: number; gapTo: number };

/**
 * LRU-capped dedup + gap-detector for inbound application-message
 * `seq` values.
 *
 * Threading model: single-threaded JavaScript; all methods are sync
 * and run on the message dispatch path. The cap is small enough that
 * the cascade loop in `accept` stays O(1) amortized across a normal
 * chat session.
 */
export class ReceiveWindow {
	private readonly cap: number;
	// `Map` preserves insertion order; iterating `keys()` yields the
	// oldest entry first, which is exactly the LRU eviction policy.
	private readonly lru: Map<number, true> = new Map();
	private highestContiguous = 0;

	constructor(cap: number = DEFAULT_RECEIVE_WINDOW_CAP) {
		if (!Number.isInteger(cap) || cap <= 0) {
			throw new Error(`ReceiveWindow: cap must be a positive integer, got ${cap}`);
		}
		this.cap = cap;
	}

	/**
	 * Record one inbound `seq`. Returns its disposition:
	 *
	 *   * `{ status: "new" }` — first sighting within the window.
	 *     The caller should forward the message to user listeners.
	 *   * `{ status: "duplicate" }` — already in the window; the
	 *     caller drops silently.
	 *   * `{ status: "gap", gapFrom, gapTo }` — `seq` is past
	 *     `highestContiguous + 1`. The caller should emit an
	 *     immediate `message-ack` carrying the current
	 *     `highestContiguous` so the sender's retransmit timer can
	 *     fill the hole.
	 */
	accept(seq: number): AcceptResult {
		if (this.lru.has(seq)) {
			// Already in the LRU — duplicates do NOT refresh the entry's
			// position. The eviction clock keeps ticking for this seq.
			return { status: "duplicate" };
		}

		// Insert. If the window is full, evict the oldest entry first.
		if (this.lru.size >= this.cap) {
			const oldest = this.lru.keys().next().value;
			if (oldest !== undefined) {
				this.lru.delete(oldest);
			}
		}
		this.lru.set(seq, true);

		const expectedNext = this.highestContiguous + 1;
		if (seq > expectedNext) {
			// gap: `seq` is past contiguity. The hole is
			// [expectedNext, seq - 1] inclusive.
			return { status: "gap", gapFrom: expectedNext, gapTo: seq - 1 };
		}
		if (seq === expectedNext) {
			this.highestContiguous = seq;
			// Cascade: if the next contiguous seq is already in the
			// window (a re-arrived out-of-order seq filled the gap
			// before this accept arrived), keep advancing. The loop
			// terminates at `cap` iterations max, but in practice the
			// gap-fill cascade is bounded by the size of the trailing
			// in-order tail of the window.
			while (this.lru.has(this.highestContiguous + 1)) {
				this.highestContiguous += 1;
			}
			return { status: "new" };
		}
		// seq < expectedNext: re-sight of a seq already past
		// contiguity but evicted from the LRU. Forward to the caller
		// as "new" so they can decide whether to re-deliver (the
		// PR-3 stand-in does re-deliver; PR-4 inherits that policy
		// because the alternative — silently dropping re-sights —
		// would lose data the user already saw).
		return { status: "new" };
	}

	/**
	 * Highest contiguous seq observed so far. Always >= 0. Starts at
	 * 0; advances only on `accept` of `seq === highestContiguous + 1`
	 * (with the cascade filling any in-window gaps).
	 */
	getHighestContiguous(): number {
		return this.highestContiguous;
	}

	/**
	 * Current window size (for tests + observability). Bounded by
	 * `cap`; shrinks when an entry is evicted and grows when a new
	 * seq is accepted. Duplicates do not change the size.
	 */
	size(): number {
		return this.lru.size;
	}

	/**
	 * Drop every tracked seq and reset `highestContiguous` to 0.
	 *
	 * Used by `MessageAckScheduler.closeSession()` so the next session
	 * (which may have different sender-side contiguity) starts with a
	 * clean window rather than inheriting stale dedup state. The
	 * scheduler's `seq` counter also resets on session close (Q10
	 * leaves the counter sticky across the same `PeerConnection` but
	 * a close is a clean break — both sides reset).
	 */
	clear(): void {
		this.lru.clear();
		this.highestContiguous = 0;
	}
}

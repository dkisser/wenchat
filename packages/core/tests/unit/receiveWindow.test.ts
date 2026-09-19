import { describe, expect, it } from "bun:test";
import { ReceiveWindow } from "../../src/receiveWindow";

// Tests for the PR-4 receiver-side dedup + gap detector (ADR 0003 Q7).
//
// The window is LRU-capped at 256 by default; tests use a smaller cap so
// eviction cases stay cheap. Each test exercises one specific contract
// from the implementation plan (§C.1 row 4 + §C.3 "Receive window full"):
//
//   * Sequential accepts → all "new", highestContiguous advances monotonically
//   * Repeat accept within the window → "duplicate"
//   * Accept with seq > highestContiguous + 1 → "gap" (no advance)
//   * Accept with seq === highestContiguous + 1 → advance + cascade fill
//   * LRU eviction when full
//   * size() reflects current LRU size
//   * clear() resets to a fresh state

describe("ReceiveWindow — basic dedup (ADR 0003 Q7)", () => {
	it("accept(1), accept(2), accept(3) → all 'new', highestContiguous=3", () => {
		const w = new ReceiveWindow();
		expect(w.accept(1)).toEqual({ status: "new" });
		expect(w.accept(2)).toEqual({ status: "new" });
		expect(w.accept(3)).toEqual({ status: "new" });
		expect(w.getHighestContiguous()).toBe(3);
		expect(w.size()).toBe(3);
	});

	it("repeat accept within the window returns 'duplicate' and does not advance highestContiguous", () => {
		const w = new ReceiveWindow();
		w.accept(1);
		w.accept(2);
		w.accept(3);
		expect(w.getHighestContiguous()).toBe(3);
		expect(w.size()).toBe(3);
		expect(w.accept(3)).toEqual({ status: "duplicate" });
		expect(w.accept(3)).toEqual({ status: "duplicate" });
		// Duplicates do not advance highestContiguous.
		expect(w.getHighestContiguous()).toBe(3);
		// The duplicate does NOT count as a fresh insert either — the
		// LRU still has exactly three entries.
		expect(w.size()).toBe(3);
	});

	it("repeat accept interleaved with new accepts stays 'duplicate'", () => {
		const w = new ReceiveWindow();
		w.accept(1);
		w.accept(2);
		expect(w.accept(1)).toEqual({ status: "duplicate" });
		expect(w.accept(3)).toEqual({ status: "new" });
		expect(w.accept(1)).toEqual({ status: "duplicate" });
		expect(w.getHighestContiguous()).toBe(3);
	});
});

describe("ReceiveWindow — gap detection", () => {
	it("accept(1), accept(3) → second is 'gap' from 2 to 2 (single missing)", () => {
		const w = new ReceiveWindow();
		expect(w.accept(1)).toEqual({ status: "new" });
		expect(w.accept(3)).toEqual({ status: "gap", gapFrom: 2, gapTo: 2 });
		// Gap does NOT advance highestContiguous — we are still missing 2.
		expect(w.getHighestContiguous()).toBe(1);
		expect(w.size()).toBe(2);
	});

	it("accept(1), accept(5) → second is 'gap' from 2 to 4", () => {
		const w = new ReceiveWindow();
		w.accept(1);
		expect(w.accept(5)).toEqual({ status: "gap", gapFrom: 2, gapTo: 4 });
		expect(w.getHighestContiguous()).toBe(1);
	});

	it("accept(1), accept(2), accept(5) → third is 'gap' from 3 to 4", () => {
		const w = new ReceiveWindow();
		w.accept(1);
		w.accept(2);
		expect(w.accept(5)).toEqual({ status: "gap", gapFrom: 3, gapTo: 4 });
		expect(w.getHighestContiguous()).toBe(2);
	});

	it("first accept is seq=2 → 'gap' from 1 to 1 (initial gap)", () => {
		const w = new ReceiveWindow();
		expect(w.accept(2)).toEqual({ status: "gap", gapFrom: 1, gapTo: 1 });
		expect(w.getHighestContiguous()).toBe(0);
		expect(w.size()).toBe(1);
	});

	it("the gap is always [highestContiguous + 1, seq - 1] inclusive", () => {
		const w = new ReceiveWindow();
		w.accept(1);
		w.accept(2);
		w.accept(4);
		// gapFrom=3, gapTo=3 (one missing)
		expect(w.accept(7)).toEqual({ status: "gap", gapFrom: 3, gapTo: 6 });
		expect(w.getHighestContiguous()).toBe(2);
	});
});

describe("ReceiveWindow — gap fill cascade (highestContiguous boundary)", () => {
	it("accept(1,2,3,5,4) — accepting 4 after 5 cascades highestContiguous to 5", () => {
		const w = new ReceiveWindow();
		w.accept(1);
		w.accept(2);
		w.accept(3);
		expect(w.accept(5)).toEqual({ status: "gap", gapFrom: 4, gapTo: 4 });
		expect(w.getHighestContiguous()).toBe(3);
		expect(w.accept(4)).toEqual({ status: "new" });
		// Cascade: 4 advances highestContiguous → 4, then 5 is in window
		// → 5, then 6 is not in window → stop. Highest = 5.
		expect(w.getHighestContiguous()).toBe(5);
		expect(w.size()).toBe(5);
	});

	it("cascade across multiple in-window entries", () => {
		const w = new ReceiveWindow();
		w.accept(1);
		w.accept(2);
		w.accept(5);
		w.accept(6);
		w.accept(7);
		expect(w.getHighestContiguous()).toBe(2);
		// Accept 3 → cascades to 7 (4 still missing → stops).
		expect(w.accept(3)).toEqual({ status: "new" });
		expect(w.getHighestContiguous()).toBe(3);
		// Accept 4 → cascades through 4, 5, 6, 7 → highest = 7.
		expect(w.accept(4)).toEqual({ status: "new" });
		expect(w.getHighestContiguous()).toBe(7);
	});

	it("cascade stops at the first in-window hole, not at the end of the window", () => {
		// Window [1, 2, 5], highestContiguous = 2. Accepting seq=3
		// advances to 3; cascade checks 4 (not in window) and stops.
		// seq=5 stays in the window but is NOT contiguous from 3
		// because 4 is missing.
		const w = new ReceiveWindow();
		w.accept(1);
		w.accept(2);
		w.accept(5); // gap from 3 to 4; highestContiguous = 2
		expect(w.getHighestContiguous()).toBe(2);
		expect(w.accept(3)).toEqual({ status: "new" });
		expect(w.getHighestContiguous()).toBe(3);
		// Cascade stopped at 3 because seq=4 is not in the window.
		// seq=5 is still in the window but is not contiguous from 3.
	});
});

describe("ReceiveWindow — LRU eviction", () => {
	it("with cap=4, accepting 5 seqs evicts the oldest", () => {
		const w = new ReceiveWindow(4);
		for (let i = 1; i <= 4; i++) {
			expect(w.accept(i)).toEqual({ status: "new" });
		}
		expect(w.size()).toBe(4);
		// The 5th seq evicts seq=1.
		expect(w.accept(5)).toEqual({ status: "new" });
		expect(w.size()).toBe(4);
		expect(w.getHighestContiguous()).toBe(5);
		// seq=1 was evicted → re-insert counts as a fresh "new".
		expect(w.accept(1)).toEqual({ status: "new" });
		// seq=5 is still in the window → "duplicate".
		expect(w.accept(5)).toEqual({ status: "duplicate" });
	});

	it("with default cap=256, the 257th accept evicts the first (giant gap test)", () => {
		const w = new ReceiveWindow();
		for (let i = 1; i <= 256; i++) {
			expect(w.accept(i)).toEqual({ status: "new" });
		}
		expect(w.size()).toBe(256);
		expect(w.getHighestContiguous()).toBe(256);
		// 257th accept — seq=257 is contiguous, so highest advances to 257.
		expect(w.accept(257)).toEqual({ status: "new" });
		expect(w.size()).toBe(256);
		expect(w.getHighestContiguous()).toBe(257);
		// seq=1 was evicted — re-sight is "new" (NOT "duplicate").
		expect(w.accept(1)).toEqual({ status: "new" });
	});

	it("a duplicate after a gap-fill does not refresh the LRU position", () => {
		// The LRU only refreshes on inserts (we don't `delete` + `set`
		// for a duplicate). A duplicate just returns "duplicate" with no
		// side effects, so the entry's eviction clock keeps ticking.
		const w = new ReceiveWindow(3);
		w.accept(1);
		w.accept(2);
		w.accept(3);
		// Re-accept seq=1 — no position refresh.
		expect(w.accept(1)).toEqual({ status: "duplicate" });
		// Insert seq=4 → evicts seq=1 (the oldest by insertion order).
		expect(w.accept(4)).toEqual({ status: "new" });
		expect(w.size()).toBe(3);
		// seq=1 was evicted, seq=2 still in window, seq=3 in window, seq=4 in window.
		expect(w.accept(2)).toEqual({ status: "duplicate" });
		expect(w.accept(3)).toEqual({ status: "duplicate" });
		expect(w.accept(4)).toEqual({ status: "duplicate" });
	});
});

describe("ReceiveWindow — re-sight semantics", () => {
	it("accepting a seq that is <= highestContiguous but not in LRU is 'new'", () => {
		const w = new ReceiveWindow(3);
		w.accept(1);
		w.accept(2);
		w.accept(3); // window full; highestContiguous = 3
		w.accept(4); // evicts 1; LRU=[2,3,4]; highestContiguous = 4
		expect(w.getHighestContiguous()).toBe(4);
		// seq=1 was evicted; re-sight is "new" but highestContiguous stays.
		// The re-insert evicts the oldest (seq=2), so LRU stays at cap=3.
		expect(w.accept(1)).toEqual({ status: "new" });
		expect(w.getHighestContiguous()).toBe(4);
		expect(w.size()).toBe(3);
	});

	it("a re-sight does not advance highestContiguous and does not emit 'duplicate'", () => {
		const w = new ReceiveWindow(4);
		w.accept(1);
		w.accept(2);
		w.accept(3);
		w.accept(4);
		w.accept(5); // evicts 1; highest = 5
		w.accept(6); // evicts 2; highest = 6
		w.accept(7); // evicts 3; LRU=[4,5,6,7]; highest = 7
		// seq=3 was evicted. It is < highestContiguous(7), but the window
		// has not seen it since eviction → "new".
		expect(w.accept(3)).toEqual({ status: "new" });
		expect(w.getHighestContiguous()).toBe(7);
	});
});

describe("ReceiveWindow — clear()", () => {
	it("clear() resets both the LRU and highestContiguous to a fresh state", () => {
		const w = new ReceiveWindow();
		w.accept(1);
		w.accept(2);
		w.accept(3);
		expect(w.size()).toBe(3);
		expect(w.getHighestContiguous()).toBe(3);

		w.clear();
		expect(w.size()).toBe(0);
		expect(w.getHighestContiguous()).toBe(0);

		// After clear, the same seqs are accepted as fresh "new".
		expect(w.accept(1)).toEqual({ status: "new" });
		expect(w.getHighestContiguous()).toBe(1);
	});

	it("clear() can be called on an empty window (no-op)", () => {
		const w = new ReceiveWindow();
		w.clear();
		expect(w.size()).toBe(0);
		expect(w.getHighestContiguous()).toBe(0);
	});
});

describe("ReceiveWindow — size() and getHighestContiguous() observers", () => {
	it("size() is 0 immediately after construction", () => {
		const w = new ReceiveWindow();
		expect(w.size()).toBe(0);
	});

	it("getHighestContiguous() is 0 immediately after construction (and after clear())", () => {
		const w = new ReceiveWindow();
		expect(w.getHighestContiguous()).toBe(0);
		w.accept(1);
		w.clear();
		expect(w.getHighestContiguous()).toBe(0);
	});

	it("size() does not exceed the cap", () => {
		const w = new ReceiveWindow(4);
		for (let i = 1; i <= 20; i++) {
			w.accept(i);
		}
		expect(w.size()).toBe(4);
	});

	it("size() does not grow on a duplicate accept", () => {
		const w = new ReceiveWindow();
		w.accept(1);
		w.accept(1);
		w.accept(1);
		expect(w.size()).toBe(1);
	});
});

describe("ReceiveWindow — initial cap parameter", () => {
	it("default cap is 256 (matches ADR 0003 Q7)", () => {
		// Verify the default by feeding 256 unique seqs and confirming
		// the 257th still gets a "new" rather than crashing or evicting
		// something inside the 1..256 range.
		const w = new ReceiveWindow();
		for (let i = 1; i <= 256; i++) {
			expect(w.accept(i)).toEqual({ status: "new" });
		}
		expect(w.size()).toBe(256);
		// 257th: evict, advance.
		expect(w.accept(257)).toEqual({ status: "new" });
		// Still 256 entries.
		expect(w.size()).toBe(256);
	});

	it("explicit cap smaller than 256 works for fast test cases", () => {
		const w = new ReceiveWindow(2);
		w.accept(1);
		w.accept(2);
		// Window full.
		expect(w.size()).toBe(2);
		w.accept(3); // evicts 1
		expect(w.size()).toBe(2);
		expect(w.getHighestContiguous()).toBe(3);
	});
});

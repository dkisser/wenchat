import { describe, expect, it } from "bun:test";
import {
	INITIAL_SCROLL_STATE,
	type ScrollMetrics,
	type ScrollState,
	clampScroll,
	isAtBottom,
	maxTopLine,
	onMessagesAppended,
	onViewportChanged,
	resolveTopLine,
	scrollDown,
	scrollToBottom,
	scrollUp,
} from "../../src/scrollState";

const metrics = (totalLines: number, viewportHeight = 10): ScrollMetrics => ({
	totalLines,
	viewportHeight,
});

const scrolled = (topLine: number, unread = 0): ScrollState => ({
	topLine,
	follow: false,
	unread,
});

describe("maxTopLine", () => {
	it("is zero when everything fits", () => {
		expect(maxTopLine(metrics(5))).toBe(0);
		expect(maxTopLine(metrics(10))).toBe(0);
	});

	it("is the overflow beyond the viewport", () => {
		expect(maxTopLine(metrics(35))).toBe(25);
	});
});

describe("resolveTopLine", () => {
	it("pins to the bottom while following", () => {
		expect(resolveTopLine(INITIAL_SCROLL_STATE, metrics(35))).toBe(25);
	});

	it("clamps a stale offset into range", () => {
		expect(resolveTopLine(scrolled(999), metrics(35))).toBe(25);
		expect(resolveTopLine(scrolled(-5), metrics(35))).toBe(0);
	});
});

describe("scrollUp", () => {
	it("leaves follow mode and moves up from the bottom", () => {
		const next = scrollUp(INITIAL_SCROLL_STATE, metrics(35), 3);
		expect(next.topLine).toBe(22);
		expect(next.follow).toBe(false);
	});

	it("clamps at the top of the log", () => {
		const next = scrollUp(scrolled(2), metrics(35), 10);
		expect(next.topLine).toBe(0);
		expect(next.follow).toBe(false);
	});

	it("is a no-op when there is nothing to scroll", () => {
		const state = INITIAL_SCROLL_STATE;
		expect(scrollUp(state, metrics(4), 3)).toBe(state);
	});

	it("returns a new object and never mutates the input", () => {
		const state = scrolled(10, 2);
		const snapshot = { ...state };
		const next = scrollUp(state, metrics(35), 3);
		expect(next).not.toBe(state);
		expect(state).toEqual(snapshot);
	});
});

describe("scrollDown", () => {
	it("moves toward the bottom without re-following early", () => {
		const next = scrollDown(scrolled(5), metrics(35), 3);
		expect(next.topLine).toBe(8);
		expect(next.follow).toBe(false);
	});

	it("re-enters follow mode and clears unread once it lands at the bottom", () => {
		const next = scrollDown(scrolled(20, 7), metrics(35), 10);
		expect(next.follow).toBe(true);
		expect(next.unread).toBe(0);
		expect(resolveTopLine(next, metrics(35))).toBe(25);
	});

	it("is a no-op when already following", () => {
		const state = INITIAL_SCROLL_STATE;
		expect(scrollDown(state, metrics(35), 3)).toBe(state);
	});

	it("keeps unread while still above the bottom", () => {
		expect(scrollDown(scrolled(5, 4), metrics(35), 3).unread).toBe(4);
	});
});

describe("isAtBottom", () => {
	it("is true while following", () => {
		expect(isAtBottom(INITIAL_SCROLL_STATE, metrics(35))).toBe(true);
	});

	it("is false once scrolled up", () => {
		expect(isAtBottom(scrolled(5), metrics(35))).toBe(false);
	});

	it("is true when the log is shorter than the viewport", () => {
		expect(isAtBottom(scrolled(0), metrics(3))).toBe(true);
	});
});

describe("onMessagesAppended", () => {
	it("does nothing while following — the view just tracks the tail", () => {
		const state = INITIAL_SCROLL_STATE;
		expect(onMessagesAppended(state, 3)).toBe(state);
	});

	it("accumulates unread while scrolled up", () => {
		const first = onMessagesAppended(scrolled(5), 2);
		expect(first.unread).toBe(2);
		expect(first.topLine).toBe(5);
		expect(onMessagesAppended(first, 3).unread).toBe(5);
	});

	it("ignores a non-positive delta", () => {
		const state = scrolled(5, 1);
		expect(onMessagesAppended(state, 0)).toBe(state);
		expect(onMessagesAppended(state, -2)).toBe(state);
	});

	it("does not mutate the input", () => {
		const state = scrolled(5, 1);
		const snapshot = { ...state };
		onMessagesAppended(state, 2);
		expect(state).toEqual(snapshot);
	});
});

describe("clampScroll / onViewportChanged", () => {
	it("pulls a now-out-of-range offset back to the bottom and re-follows", () => {
		// e.g. the message log was trimmed at MAX_MESSAGES.
		const next = clampScroll(scrolled(90, 4), metrics(35));
		expect(next.follow).toBe(true);
		expect(next.unread).toBe(0);
	});

	it("keeps an in-range offset put when the viewport shrinks", () => {
		const next = onViewportChanged(scrolled(5, 2), metrics(35, 6));
		expect(next.topLine).toBe(5);
		expect(next.follow).toBe(false);
		expect(next.unread).toBe(2);
	});

	it("keeps a follower at the bottom across a resize", () => {
		const next = onViewportChanged(INITIAL_SCROLL_STATE, metrics(35, 4));
		expect(next.follow).toBe(true);
		expect(resolveTopLine(next, metrics(35, 4))).toBe(31);
	});
});

describe("scrollToBottom", () => {
	it("re-follows and clears unread", () => {
		const next = scrollToBottom(scrolled(5, 9), metrics(35));
		expect(next).toEqual({ topLine: 25, follow: true, unread: 0 });
	});
});

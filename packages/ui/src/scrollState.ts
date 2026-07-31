/**
 * Pure scroll model for the chat viewport. Every function returns a new state
 * (or the input untouched when the operation is a genuine no-op) and never
 * mutates its arguments.
 */

export type ScrollState = {
	/** Index of the first visible display line. Ignored while `follow`. */
	readonly topLine: number;
	/** Pinned to the newest line; new messages scroll the view. */
	readonly follow: boolean;
	/** Messages that arrived since the user scrolled away from the bottom. */
	readonly unread: number;
};

export type ScrollMetrics = {
	readonly totalLines: number;
	readonly viewportHeight: number;
};

export const INITIAL_SCROLL_STATE: ScrollState = Object.freeze({
	topLine: 0,
	follow: true,
	unread: 0,
});

/**
 * Why the offset is measured from the top *and* paired with an explicit
 * `follow` flag: measuring from the bottom would force us to bump the offset
 * on every append just to keep the view still, which is bookkeeping on the
 * hot path. Measuring from the top makes "stay put" free — existing line
 * indices do not move when lines are appended. The cost is that
 * `topLine === maxTopLine` stops meaning "at the bottom" the moment new lines
 * land, so "at the bottom" has to be tracked explicitly.
 */
export function maxTopLine({ totalLines, viewportHeight }: ScrollMetrics): number {
	return Math.max(0, totalLines - viewportHeight);
}

export function resolveTopLine(state: ScrollState, metrics: ScrollMetrics): number {
	const max = maxTopLine(metrics);
	return state.follow ? max : clamp(state.topLine, 0, max);
}

export function isAtBottom(state: ScrollState, metrics: ScrollMetrics): boolean {
	return state.follow || resolveTopLine(state, metrics) >= maxTopLine(metrics);
}

/** Move by `delta` display lines; negative scrolls toward older messages. */
export function scrollBy(state: ScrollState, metrics: ScrollMetrics, delta: number): ScrollState {
	const max = maxTopLine(metrics);
	const current = resolveTopLine(state, metrics);
	const next = clamp(current + delta, 0, max);

	if (next >= max) {
		// Landing on the newest line resumes auto-follow, mirroring how every
		// chat client behaves, and clears the unread badge.
		return state.follow ? state : { topLine: max, follow: true, unread: 0 };
	}
	if (!state.follow && state.topLine === next) return state;
	return { topLine: next, follow: false, unread: state.unread };
}

export function scrollUp(state: ScrollState, metrics: ScrollMetrics, lines: number): ScrollState {
	return scrollBy(state, metrics, -Math.abs(lines));
}

export function scrollDown(state: ScrollState, metrics: ScrollMetrics, lines: number): ScrollState {
	return scrollBy(state, metrics, Math.abs(lines));
}

export function scrollToBottom(state: ScrollState, metrics: ScrollMetrics): ScrollState {
	const max = maxTopLine(metrics);
	if (state.follow && state.unread === 0) return state;
	return { topLine: max, follow: true, unread: 0 };
}

/** Fold newly appended messages into the unread badge. */
export function onMessagesAppended(state: ScrollState, addedCount: number): ScrollState {
	if (addedCount <= 0 || state.follow) return state;
	return { ...state, unread: state.unread + addedCount };
}

/** Pull an offset back into range after a resize, re-wrap, or log trim. */
export function clampScroll(state: ScrollState, metrics: ScrollMetrics): ScrollState {
	if (state.follow) return state;
	const max = maxTopLine(metrics);
	if (state.topLine >= max) return { topLine: max, follow: true, unread: 0 };
	if (state.topLine < 0) return { ...state, topLine: 0 };
	return state;
}

export const onViewportChanged = clampScroll;

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

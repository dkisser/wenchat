import type { Message } from "@wenchat/protocol";
import { useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { sliceViewport, toDisplayLines } from "./displayLines";
import {
	INITIAL_SCROLL_STATE,
	type ScrollMetrics,
	clampScroll,
	isAtBottom,
	onMessagesAppended,
	onViewportChanged,
	resolveTopLine,
	scrollDown,
	scrollUp,
} from "./scrollState";
import { useMouseWheel } from "./useMouseWheel";

/** Rows moved per wheel tick — matches the usual terminal-emulator default. */
const DEFAULT_WHEEL_LINES = 3;

export type UseChatScrollArgs = {
	readonly messages: readonly Message[];
	readonly localId: string;
	readonly contentWidth: number;
	readonly viewportHeight: number;
	/** False while the chat is not on screen, so key handling stays exclusive. */
	readonly isActive?: boolean;
	readonly wheelLines?: number;
};

export type UseChatScrollResult = {
	readonly visibleLines: readonly string[];
	readonly firstLineIndex: number;
	readonly unread: number;
	readonly atBottom: boolean;
	readonly totalLines: number;
};

/**
 * Wrap the message log into display lines and expose the scrolled window.
 *
 * Scrolling is driven by the mouse wheel plus PageUp/PageDown and Shift+Arrow
 * as a keyboard fallback (plain arrows stay with the InputBox's shell-style
 * history recall).
 */
export function useChatScroll({
	messages,
	localId,
	contentWidth,
	viewportHeight,
	isActive = true,
	wheelLines = DEFAULT_WHEEL_LINES,
}: UseChatScrollArgs): UseChatScrollResult {
	const lines = useMemo(
		() => toDisplayLines(messages, localId, contentWidth),
		[messages, localId, contentWidth],
	);

	const metrics: ScrollMetrics = { totalLines: lines.length, viewportHeight };
	// Event handlers registered once must still see fresh metrics, so mirror
	// them into a ref rather than rebuilding the listeners on every keystroke.
	const metricsRef = useRef(metrics);
	metricsRef.current = metrics;

	const [state, setState] = useState(INITIAL_SCROLL_STATE);

	const messageCountRef = useRef(messages.length);
	useEffect(() => {
		const delta = messages.length - messageCountRef.current;
		messageCountRef.current = messages.length;
		if (delta > 0) {
			// React batches bursts, so five messages arrive as one delta of 5
			// rather than five separate increments — no count is lost.
			setState((prev) => onMessagesAppended(prev, delta));
		} else if (delta < 0) {
			// The log was trimmed at its cap; the offset may now be past the end.
			setState((prev) => clampScroll(prev, metricsRef.current));
		}
	}, [messages.length]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: lines is memoised on messages/localId/contentWidth, so listing those deps transitively captures it
	useEffect(() => {
		setState((prev) => onViewportChanged(prev, metricsRef.current));
	}, [viewportHeight, lines.length, messages, localId, contentWidth]);

	useMouseWheel(
		(direction) => {
			setState((prev) =>
				direction === "up"
					? scrollUp(prev, metricsRef.current, wheelLines)
					: scrollDown(prev, metricsRef.current, wheelLines),
			);
		},
		{ isActive },
	);

	useInput(
		(_input, key) => {
			const current = metricsRef.current;
			const page = Math.max(1, current.viewportHeight - 1);
			if (key.pageUp) {
				setState((prev) => scrollUp(prev, current, page));
			} else if (key.pageDown) {
				setState((prev) => scrollDown(prev, current, page));
			} else if (key.shift && key.upArrow) {
				setState((prev) => scrollUp(prev, current, 1));
			} else if (key.shift && key.downArrow) {
				setState((prev) => scrollDown(prev, current, 1));
			}
		},
		{ isActive },
	);

	const topLine = resolveTopLine(state, metrics);
	return {
		visibleLines: sliceViewport(lines, topLine, viewportHeight),
		firstLineIndex: topLine,
		unread: state.unread,
		atBottom: isAtBottom(state, metrics),
		totalLines: lines.length,
	};
}

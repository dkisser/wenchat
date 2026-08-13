import { useStdin } from "ink";
import { useEffect, useRef } from "react";
import { MAX_PENDING_BYTES, type MouseEvent, parseMouseChunk } from "./mouseEvents";

export type DoubleClickHandler = (column: number, row: number, event: MouseEvent) => void;

export type UseDoubleClickOptions = {
	/** Skip the listener while the chat view is not on screen. */
	readonly isActive?: boolean;
	/** Time window between two presses to count as a double-click. */
	readonly windowMs?: number;
};

/**
 * Fire `handler` when two left-button presses arrive at the same (col, row)
 * within `windowMs` of each other.
 *
 * The SGR protocol emits a press/release pair per click. We debounce on the
 * leading press and treat the next press at the same cell inside the window
 * as the second click — we deliberately do not wait for a release, because
 * the OS already debounces the click for us and a second-press-only rule
 * matches every terminal emulator WenChat targets.
 *
 * Right and middle buttons are ignored (button mask `0b11 != 0`). Wheel ticks
 * never reach this filter because `parseMouseChunk` decodes them as
 * `"wheel-up"`/`"wheel-down"` rather than `"other"`.
 *
 * Listener-management note: like `useMouseWheel`, this hook attaches to
 * ink's `internal_eventEmitter` rather than `stdin.on("data")`. Attaching a
 * `data` listener would flip the stream into flowing mode and starve ink's
 * own `read()` loop, killing all keyboard input.
 */
export function useDoubleClick(handler: DoubleClickHandler, options?: UseDoubleClickOptions): void {
	const { isRawModeSupported, setRawMode, internal_eventEmitter } = useStdin();
	const isActive = options?.isActive ?? true;
	const windowMs = options?.windowMs ?? 500;

	const handlerRef = useRef(handler);
	useEffect(() => {
		handlerRef.current = handler;
	});

	useEffect(() => {
		if (!isActive || !isRawModeSupported || !internal_eventEmitter) return;

		setRawMode(true);
		let pending = "";
		let lastPress: { col: number; row: number; at: number } | null = null;

		const onInput = (chunk: unknown) => {
			const { events, rest } = parseMouseChunk(pending + String(chunk));
			pending = rest.length > MAX_PENDING_BYTES ? "" : rest;
			const now = Date.now();
			for (const event of events) {
				// Left-button press only. `parseMouseChunk` decodes wheel
				// reports as wheel-up/wheel-down, which fall through this
				// filter naturally; right/middle presses are discarded by
				// the button-mask check.
				if (event.button !== "other") continue;
				if (event.release) continue;
				if ((event.buttonCode & 0b11) !== 0) continue;

				if (
					lastPress &&
					lastPress.col === event.column &&
					lastPress.row === event.row &&
					now - lastPress.at <= windowMs
				) {
					handlerRef.current(event.column, event.row, event);
					// Require a fresh pair — a third press without an
					// intervening different click should not re-fire.
					lastPress = null;
				} else {
					lastPress = { col: event.column, row: event.row, at: now };
				}
			}
		};

		internal_eventEmitter.on("input", onInput);
		return () => {
			internal_eventEmitter.removeListener("input", onInput);
			setRawMode(false);
		};
	}, [isActive, isRawModeSupported, setRawMode, internal_eventEmitter, windowMs]);
}

import { useStdin } from "ink";
import { useEffect, useRef } from "react";
import { MAX_PENDING_BYTES, type MouseEvent, parseMouseChunk } from "./mouseEvents";

export type WheelDirection = "up" | "down";

export type MouseWheelHandler = (direction: WheelDirection, event: MouseEvent) => void;

export type UseMouseWheelOptions = {
	readonly isActive?: boolean;
};

/**
 * Call `handler` for every wheel tick the terminal reports.
 *
 * Requires the CLI to have turned on mouse reporting (see
 * `apps/cli/src/mouseMode.ts`); without it the terminal never emits reports
 * and this hook simply stays quiet.
 *
 * Implementation note, pinned to ink@5.2.1: we subscribe to ink's
 * `internal_eventEmitter` rather than adding our own `stdin.on("data")`
 * listener. ink drives input with a `readable` listener plus `stdin.read()`;
 * attaching a `data` listener would flip the stream into flowing mode, ink's
 * `read()` would start returning null, and *all* keyboard input would die.
 * The emitter is a plain fan-out of the chunk ink already read, so listening
 * consumes nothing — and the chunk still has its ESC bytes intact, which is
 * strictly better for parsing than what `useInput` hands you.
 */
export function useMouseWheel(handler: MouseWheelHandler, options?: UseMouseWheelOptions): void {
	const { isRawModeSupported, setRawMode, internal_eventEmitter } = useStdin();
	const isActive = options?.isActive ?? true;

	const handlerRef = useRef(handler);
	useEffect(() => {
		handlerRef.current = handler;
	});

	const pendingRef = useRef("");

	useEffect(() => {
		if (!isActive || !isRawModeSupported || !internal_eventEmitter) return;

		// ink ref-counts raw mode, so enabling it here composes safely with
		// the useInput calls in InputBox / PeerList.
		setRawMode(true);
		pendingRef.current = "";

		const onInput = (chunk: unknown) => {
			const { events, rest } = parseMouseChunk(pendingRef.current + String(chunk));
			pendingRef.current = rest.length > MAX_PENDING_BYTES ? "" : rest;
			for (const event of events) {
				if (event.button === "wheel-up") handlerRef.current("up", event);
				else if (event.button === "wheel-down") handlerRef.current("down", event);
			}
		};

		internal_eventEmitter.on("input", onInput);
		return () => {
			internal_eventEmitter.removeListener("input", onInput);
			setRawMode(false);
		};
	}, [isActive, isRawModeSupported, setRawMode, internal_eventEmitter]);
}

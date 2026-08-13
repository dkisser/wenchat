import type { Message } from "@wenchat/protocol";
import wrapAnsi from "wrap-ansi";
import { renderMarkdown } from "./markdown";

/**
 * Turning the message log into a flat list of *display lines* is what makes
 * scrolling well-defined: a scroll offset counted in messages jumps by a
 * variable number of rows, while an offset counted in wrapped lines maps 1:1
 * onto what the terminal shows.
 */

/**
 * Render a message as the single logical line the chat shows for it.
 */
export function formatMessage(message: Message, localId: string): string {
	// The CLI marks local-only system entries with `id: \`system-${randomUUID()}\``
	// (see apps/cli/src/App.tsx). Detect that prefix ahead of the local/peer
	// check so a system entry never accidentally collides with a peer's UUID
	// prefix.
	let prefix: "system" | "me" | "peer";
	if (message.id.startsWith("system-")) {
		prefix = "system";
	} else {
		prefix = message.id.startsWith(localId) ? "me" : "peer";
	}
	if (message.type === "text") {
		// System entries are operator-controlled strings ("Connected to …",
		// "Lost connection to …"). They must never be interpreted as
		// markdown — a future "Connected to https://wenchat.local" would
		// otherwise accidentally render the URL as a hyperlink. User-sent
		// messages (me/peer) go through the renderer so their original
		// newlines, indentation, and consecutive spaces survive.
		const body = prefix === "system" ? message.payload.text : renderMarkdown(message.payload.text);
		return `[${prefix}] ${body}`;
	}
	if (message.type === "file-start") {
		return `[${prefix}] sending file: ${message.payload.fileName}`;
	}
	return `[${prefix}] ${message.type}`;
}

/**
 * Soft-wrap one logical line into terminal rows.
 *
 * This deliberately calls `wrap-ansi` with byte-identical options to ink's own
 * `wrap-text.js` (`{trim: false, hard: true}`). Any divergence between our
 * line count and ink's would desynchronise the fixed-height layout, so we use
 * the same function rather than reimplementing the measurement. `wrap-ansi`
 * measures via `string-width`, which counts CJK glyphs as two columns.
 */
export function wrapToWidth(text: string, width: number): readonly string[] {
	return wrapAnsi(text, Math.max(1, width), { trim: false, hard: true }).split("\n");
}

/**
 * Result of flattening the message log into wrapped display lines.
 *
 * `messageStartIndices` is parallel to the input messages: `start[i]` is the
 * global line index where `messages[i]` begins rendering. The hook uses it
 * to map a double-clicked terminal row back to the message that owns it.
 */
export type DisplayLines = {
	readonly lines: readonly string[];
	readonly messageStartIndices: readonly number[];
};

/**
 * Flatten the message log into wrapped display lines, oldest first.
 *
 * Returns both the wrapped output and a parallel `messageStartIndices` array
 * so callers can answer "which message owns line N?" in O(log n).
 */
export function toDisplayLines(
	messages: readonly Message[],
	localId: string,
	contentWidth: number,
): DisplayLines {
	const lines: string[] = [];
	const messageStartIndices: number[] = [];
	for (const message of messages) {
		messageStartIndices.push(lines.length);
		lines.push(...wrapToWidth(formatMessage(message, localId), contentWidth));
	}
	return { lines, messageStartIndices };
}

/**
 * Find the index of the message whose display lines contain `globalLineIndex`.
 * Returns -1 when `globalLineIndex` falls before the first message start
 * (a defensive case — in practice firstLineIndex is always clamped ≥ 0) or
 * past the last visible line.
 */
export function findMessageAtLine(
	messageStartIndices: readonly number[],
	globalLineIndex: number,
): number {
	if (messageStartIndices.length === 0) return -1;
	let lo = 0;
	let hi = messageStartIndices.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const start = messageStartIndices[mid] ?? 0;
		const end =
			mid + 1 < messageStartIndices.length
				? (messageStartIndices[mid + 1] ?? 0)
				: Number.POSITIVE_INFINITY;
		if (globalLineIndex >= start && globalLineIndex < end) return mid;
		if (globalLineIndex < start) hi = mid - 1;
		else lo = mid + 1;
	}
	return -1;
}

/**
 * Take the `height` display lines starting at `topLine`, tolerating
 * out-of-range offsets (which happen transiently on resize).
 */
export function sliceViewport(
	lines: readonly string[],
	topLine: number,
	height: number,
): readonly string[] {
	if (height <= 0) return [];
	const start = Math.min(Math.max(topLine, 0), lines.length);
	return lines.slice(start, start + height);
}

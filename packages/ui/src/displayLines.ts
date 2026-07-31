import type { Message } from "@wenchat/protocol";
import wrapAnsi from "wrap-ansi";

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
		return `[${prefix}] ${message.payload.text}`;
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
 * Flatten the message log into wrapped display lines, oldest first.
 */
export function toDisplayLines(
	messages: readonly Message[],
	localId: string,
	contentWidth: number,
): readonly string[] {
	const lines: string[] = [];
	for (const message of messages) {
		lines.push(...wrapToWidth(formatMessage(message, localId), contentWidth));
	}
	return lines;
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

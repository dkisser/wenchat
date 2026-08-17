import type { Message } from "@wenchat/protocol";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { renderMarkdown } from "./markdown";

/**
 * Turning the message log into a flat list of *display lines* is what makes
 * scrolling well-defined: a scroll offset counted in messages jumps by a
 * variable number of rows, while an offset counted in wrapped lines maps 1:1
 * onto what the terminal shows.
 */

/** Nicknames used for the sender column. The peer name may not be known yet. */
export type ChatNames = {
	readonly local: string;
	readonly peer?: string;
};

/**
 * A message split into the styled sender prefix and its text body.
 * `toDisplayLines` assembles the two into terminal rows — the prefix never
 * goes through wrap-ansi itself, so its ANSI styling can't confuse the
 * wrapper's column math.
 */
export type FormattedMessage = {
	readonly system: boolean;
	/** ANSI-styled `"HH:mm  name  "` prefix; empty for system entries. */
	readonly prefix: string;
	/** Visible column width of `prefix`; 0 for system entries. */
	readonly prefixWidth: number;
	/** Markdown-rendered user text, or verbatim dimmed system text. */
	readonly body: string;
};

const GRAY = "\x1b[90m";
const CYAN_BOLD = "\x1b[36m\x1b[1m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";

/** Local-time `HH:mm` — when the message was sent/received on this LAN. */
export function formatTimestamp(timestamp: number): string {
	const date = new Date(timestamp);
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}

/**
 * Split a message into its styled prefix and body.
 *
 * Sender column: dim timestamp, then the nickname — cyan + bold for the
 * local user, magenta for the peer — padded to the wider of the two names
 * so both senders' bodies start in the same column. System entries carry no
 * prefix at all; they render as a bare dimmed line.
 */
export function formatMessage(
	message: Message,
	localId: string,
	names: ChatNames,
): FormattedMessage {
	// The CLI marks local-only system entries with `id: \`system-${randomUUID()}\``
	// (see apps/cli/src/App.tsx). Detect that prefix ahead of the local/peer
	// check so a system entry never accidentally collides with a peer's UUID
	// prefix.
	if (message.id.startsWith("system-")) {
		// System entries are operator-controlled strings ("Connected to …",
		// "Lost connection to …"). They must never be interpreted as
		// markdown — a future "Connected to https://wenchat.local" would
		// otherwise accidentally render the URL as a hyperlink.
		const text = message.type === "text" ? message.payload.text : message.type;
		return { system: true, prefix: "", prefixWidth: 0, body: `${GRAY}${text}${RESET}` };
	}

	const mine = message.id.startsWith(localId);
	const localName = names.local || "me";
	const peerName = names.peer ?? "peer";
	// string-width (not String.length) so a CJK nickname pads by columns.
	const nameWidth = Math.max(stringWidth(localName), stringWidth(peerName));
	const name = mine ? localName : peerName;
	const pad = " ".repeat(Math.max(nameWidth - stringWidth(name), 0));
	const styledName = mine ? `${CYAN_BOLD}${name}${RESET}` : `${MAGENTA}${name}${RESET}`;
	const prefix = `${GRAY}${formatTimestamp(message.timestamp)}${RESET}  ${styledName}${pad}  `;
	const prefixWidth = 5 + 2 + nameWidth + 2;

	let body: string;
	if (message.type === "text") {
		// User-sent messages (me/peer) go through the renderer so their
		// original newlines, indentation, and consecutive spaces survive.
		body = renderMarkdown(message.payload.text);
	} else if (message.type === "file-start") {
		body = `sending file: ${message.payload.fileName}`;
	} else {
		body = message.type;
	}
	return { system: false, prefix, prefixWidth, body };
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
 * to map a double-clicked terminal row back to the message owning that line.
 */
export type DisplayLines = {
	readonly lines: readonly string[];
	readonly messageStartIndices: readonly number[];
};

/**
 * Flatten the message log into wrapped display lines, oldest first.
 *
 * Each non-system message renders as `prefix + body`, with both soft-wrap
 * continuations and embedded newlines indented by blank spaces to the body
 * column. The body is wrapped *before* the prefix is attached, so every
 * assembled row is at most `contentWidth` columns and ink's own re-wrap
 * (same wrap-ansi options) is a no-op — the "flat line count = rendered
 * row count" invariant holds. If the terminal is narrower than the prefix
 * itself this breaks (rows re-wrap and the count drifts); that is accepted
 * as pathological — realistic widths leave far more room than the ~9 +
 * nameWidth columns a prefix needs.
 *
 * Returns both the wrapped output and a parallel `messageStartIndices` array
 * so callers can answer "which message owns line N?" in O(log n).
 */
export function toDisplayLines(
	messages: readonly Message[],
	localId: string,
	names: ChatNames,
	contentWidth: number,
): DisplayLines {
	const lines: string[] = [];
	const messageStartIndices: number[] = [];
	for (const [index, message] of messages.entries()) {
		messageStartIndices.push(lines.length);
		const formatted = formatMessage(message, localId, names);
		if (formatted.system) {
			// A blank separator row sets system entries apart from the chatter
			// above. It belongs to this message's line block (its start index
			// is already pushed), so double-click copy still resolves to it.
			if (index > 0) lines.push(" ");
			for (const line of wrapToWidth(formatted.body, contentWidth)) {
				lines.push(line.length > 0 ? line : " ");
			}
			continue;
		}
		const bodyWidth = Math.max(1, contentWidth - formatted.prefixWidth);
		const indent = " ".repeat(formatted.prefixWidth);
		for (const [segmentIndex, segment] of formatted.body.split("\n").entries()) {
			for (const [wrapIndex, wrapped] of wrapToWidth(segment, bodyWidth).entries()) {
				lines.push(
					segmentIndex === 0 && wrapIndex === 0 ? formatted.prefix + wrapped : indent + wrapped,
				);
			}
		}
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

/**
 * Pure geometry for the chat screen.
 *
 * Why this exists at all: ink 5's root node only ever gets `setWidth()` (see
 * `ink/build/ink.js` — `calculateLayout` never touches height), so a
 * percentage `height` on the root Box resolves against nothing and degrades to
 * `auto`. The only way to pin the InputBox to the last row is to compute a
 * concrete row count ourselves and hand ink a numeric height.
 */

export type ChatLayoutInput = {
	readonly rows: number;
	readonly columns: number;
	readonly suggestionVisible: boolean;
};

export type ChatLayout = {
	/** Height of the root Box, in terminal rows. */
	readonly frameHeight: number;
	/** Height of the ChatView Box, including its two border rows. */
	readonly chatOuterHeight: number;
	/** Number of display lines the ChatView can actually show. */
	readonly viewportHeight: number;
	/** Usable text width inside a bordered, paddingX={1} Box. */
	readonly contentWidth: number;
	/** True when the terminal is too short to hold the full chrome. */
	readonly degraded: boolean;
};

/**
 * Rows consumed by each piece of fixed chrome. The StatusBar is unbordered
 * (one coloured line), so it costs a single row. InputBox and
 * CommandSuggestion are each a single line of text inside a bordered Box
 * with no vertical padding, so they cost 1 + 2 border rows.
 */
export const CHROME_ROWS = {
	statusBar: 1,
	inputBox: 3,
	commandSuggestion: 3,
	chatBorder: 2,
} as const;

/** Below this the TUI is unusable anyway; clamp instead of going negative. */
export const MIN_FRAME_HEIGHT = 6;

/** A bordered Box still needs one content row between its two border rows. */
const MIN_CHAT_OUTER_HEIGHT = 3;

/** Left border + left padding + right padding + right border. */
const HORIZONTAL_CHROME = 4;

export function computeChatLayout({
	rows,
	columns,
	suggestionVisible,
}: ChatLayoutInput): ChatLayout {
	// `rows - 1`: log-update writes the frame plus a trailing newline, so an
	// N-line frame occupies N+1 rows. At N === rows the top line scrolls away
	// and ink starts emitting `clearTerminal` (\x1b[2J\x1b[3J\x1b[H) on every
	// single frame, wiping the user's scrollback each time.
	const frameHeight = Math.max(rows - 1, MIN_FRAME_HEIGHT);

	const chrome =
		CHROME_ROWS.statusBar +
		CHROME_ROWS.inputBox +
		(suggestionVisible ? CHROME_ROWS.commandSuggestion : 0);

	const available = frameHeight - chrome;
	const chatOuterHeight = Math.max(available, MIN_CHAT_OUTER_HEIGHT);

	return {
		frameHeight,
		chatOuterHeight,
		viewportHeight: Math.max(chatOuterHeight - CHROME_ROWS.chatBorder, 1),
		contentWidth: Math.max(columns - HORIZONTAL_CHROME, 1),
		degraded: available < MIN_CHAT_OUTER_HEIGHT,
	};
}

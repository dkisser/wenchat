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
	/**
	 * True when the `/file` completion picker is on screen. Mutually
	 * exclusive with `suggestionVisible` (the picker wins) — the caller
	 * enforces that; this module only does the row accounting.
	 */
	readonly fileSuggestionVisible?: boolean;
	/**
	 * True when the masthead `Header` (logo + info) replaces the single-line
	 * StatusBar as the top chrome. Defaults to false so existing callers and
	 * the HostPicker phase keep the one-row status strip.
	 */
	readonly logoHeader?: boolean;
};

export type ChatLayout = {
	/** Height of the root Box, in terminal rows. */
	readonly frameHeight: number;
	/** Rows reserved for the middle pane: gutter row + ChatView viewport. */
	readonly chatOuterHeight: number;
	/** Number of display lines the ChatView can actually show. */
	readonly viewportHeight: number;
	/** Usable text width inside the borderless, paddingX={1} chat pane. */
	readonly contentWidth: number;
	/** True when the terminal is too short to hold the full chrome. */
	readonly degraded: boolean;
};

/**
 * Rows consumed by each piece of fixed chrome. The StatusBar is unbordered
 * (one coloured line), so it costs a single row; the logo Header costs its
 * four wordmark rows. InputBox and CommandSuggestion are each a single line
 * of text inside a bordered Box with no vertical padding, so they cost
 * 1 + 2 border rows. The chat pane itself is borderless — it only budgets
 * one blank gutter row between the top chrome and the first message, plus
 * one blank top-margin row above everything so no text touches terminal
 * row 0.
 */
export const CHROME_ROWS = {
	statusBar: 1,
	header: 4,
	inputBox: 3,
	commandSuggestion: 3,
	/** Up to 4 candidates plus two border rows. */
	fileSuggestion: 6,
	chatGutter: 1,
	topMargin: 1,
} as const;

/** Below this the TUI is unusable anyway; clamp instead of going negative. */
export const MIN_FRAME_HEIGHT = 6;

/** The borderless pane still needs one content row below its gutter row. */
const MIN_CHAT_OUTER_HEIGHT = 3;

/** Left padding + right padding — the chat pane no longer draws borders. */
const HORIZONTAL_CHROME = 2;

export function computeChatLayout({
	rows,
	columns,
	suggestionVisible,
	fileSuggestionVisible = false,
	logoHeader = false,
}: ChatLayoutInput): ChatLayout {
	// `rows - 1`: log-update writes the frame plus a trailing newline, so an
	// N-line frame occupies N+1 rows. At N === rows the top line scrolls away
	// and ink starts emitting `clearTerminal` (\x1b[2J\x1b[3J\x1b[H) on every
	// single frame, wiping the user's scrollback each time.
	const frameHeight = Math.max(rows - 1, MIN_FRAME_HEIGHT);

	const chrome =
		CHROME_ROWS.topMargin +
		(logoHeader ? CHROME_ROWS.header : CHROME_ROWS.statusBar) +
		CHROME_ROWS.inputBox +
		(suggestionVisible ? CHROME_ROWS.commandSuggestion : 0) +
		(fileSuggestionVisible ? CHROME_ROWS.fileSuggestion : 0);

	const available = frameHeight - chrome;
	const chatOuterHeight = Math.max(available, MIN_CHAT_OUTER_HEIGHT);

	return {
		frameHeight,
		chatOuterHeight,
		viewportHeight: Math.max(chatOuterHeight - CHROME_ROWS.chatGutter, 1),
		contentWidth: Math.max(columns - HORIZONTAL_CHROME, 1),
		degraded: available < MIN_CHAT_OUTER_HEIGHT,
	};
}

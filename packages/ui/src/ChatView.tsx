import { Box, Text } from "ink";

export type ChatViewProps = {
	/** Display lines already sliced to the visible window, oldest first. */
	readonly lines: readonly string[];
	/** Index of `lines[0]` in the full log — used only for stable React keys. */
	readonly firstLineIndex?: number;
	/** Messages that arrived while the user was scrolled up. */
	readonly unread?: number;
	/**
	 * Viewport height in terminal rows — the pane is borderless, so this is
	 * exactly the number of display lines shown. Omit to size to content
	 * (non-TTY output and tests, where there is nothing to pin).
	 */
	readonly height?: number;
};

/**
 * Presentational chat viewport. All scrolling logic lives in `useChatScroll`;
 * this component only draws the window it is handed.
 */
export function ChatView({ lines, firstLineIndex = 0, unread = 0, height }: ChatViewProps) {
	const capacity = height === undefined ? lines.length : Math.max(height, 1);

	// The unread indicator takes over the last visible row instead of adding
	// one. Adding a row would make the viewport height depend on `unread`,
	// which in turn depends on the viewport height — a circular dependency.
	// Dropping a line only ever happens while scrolled up, where the bottom
	// line is not what the user is reading anyway.
	const showIndicator = unread > 0;
	const body =
		showIndicator && lines.length >= capacity ? lines.slice(0, Math.max(capacity - 1, 0)) : lines;

	return (
		<Box
			flexDirection="column"
			paddingX={1}
			height={height}
			flexShrink={0}
			flexGrow={height === undefined ? 1 : 0}
			overflow="hidden"
		>
			{body.map((line, index) => (
				// An empty <Text> renders zero rows in ink (render-node-to-output
				// skips zero-length text), which would shrink the frame — so a
				// blank line is drawn as a single space. Each visible line has a
				// globally unique log index (`firstLineIndex + index`), so the
				// key is stable across re-renders and no React reconciliation
				// confusion is possible.
				//
				// `wrap="wrap"` (not `"truncate-end"`) so Ink soft-wraps long
				// content with the same wrap-ansi options `{trim:false,
				// hard:true}` that `wrapToWidth` uses upstream — keeping the
				// "flat line count = rendered row count" invariant intact.
				// biome-ignore lint/suspicious/noArrayIndexKey: keyed by global log index, not per-render array index
				<Text key={firstLineIndex + index} wrap="wrap">
					{line.length > 0 ? line : " "}
				</Text>
			))}
			{showIndicator && (
				<Text color="yellow">{`↓ ${unread} new message${unread === 1 ? "" : "s"}`}</Text>
			)}
		</Box>
	);
}

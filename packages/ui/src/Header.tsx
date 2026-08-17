import { Box, Text } from "ink";
import {
	type StatusBarStatus,
	type StatusBarToast,
	formatStatusText,
	statusColor,
} from "./StatusBar";
import { LOGO_LINES } from "./logo";

/**
 * Below this terminal width the caller should render the single-line
 * StatusBar instead: the 38-column wordmark plus a gap leaves too little
 * room for the info column to say anything useful.
 */
export const MIN_LOGO_HEADER_COLUMNS = 72;

export type HeaderProps = {
	status: StatusBarStatus;
	peerName?: string;
	peerEndpoint?: string;
	/** Local display name shown on the identity line ("You: <name> · …"). */
	localName: string;
	/** Local signaling endpoint (`host:port`) once the listener is bound. */
	localEndpoint?: string;
	/** CLI version string ("dev" outside packed binaries). */
	version?: string;
	/**
	 * False while the terminal reports mouse events to the app — the hints
	 * line then carries a reminder of how to flip back to scroll mode.
	 */
	mouseEnabled?: boolean;
	/**
	 * Transient notice shown at the right edge of the status row, same
	 * semantics as the StatusBar toast: the caller owns the timing.
	 */
	toast?: StatusBarToast | null;
};

/**
 * Multi-line masthead shown above the chat viewport once a bind address is
 * chosen: the WENCHAT wordmark on the left, announcement-style info on the
 * right (connection state, local identity, copy/scroll hints).
 *
 * Height is fixed at `CHROME_ROWS.header` rows — the layout math in
 * `chatLayout.ts` and the double-click row mapping in `App.tsx` both depend
 * on it. Every right-column line uses `wrap="truncate-end"` so a narrow
 * terminal clips text instead of wrapping it and breaking that invariant.
 * (Below `MIN_LOGO_HEADER_COLUMNS` the caller renders StatusBar instead.)
 */
export function Header({
	status,
	peerName,
	peerEndpoint,
	localName,
	localEndpoint,
	version,
	mouseEnabled = true,
	toast = null,
}: HeaderProps) {
	const identity = `You: ${localName}${localEndpoint ? ` · ${localEndpoint}` : ""}${version ? ` · ${version}` : ""}`;
	const hints = `Double-click to copy · /help${mouseEnabled ? "" : " · Select mode (Ctrl+T)"}`;

	return (
		<Box flexDirection="row" paddingLeft={1} width="100%">
			<Box flexDirection="column" flexShrink={0}>
				{LOGO_LINES.map((line) => (
					<Text key={line} color="cyan" wrap="truncate-end">
						{line}
					</Text>
				))}
			</Box>
			{/* marginTop={1} drops the three info lines onto logo rows 2–4, so
			    the column sits visually centred against the wordmark instead of
			    hugging the top. 1 + 3 rows = the same 4-row header height. */}
			<Box flexDirection="column" flexGrow={1} marginLeft={2} marginTop={1}>
				<Box flexDirection="row" justifyContent="space-between">
					<Text color={statusColor(status)} wrap="truncate-end">
						{formatStatusText(status, peerName, peerEndpoint)}
					</Text>
					{toast && (
						<Text color={toast.tone === "error" ? "red" : "gray"} wrap="truncate-end">
							{toast.text}
						</Text>
					)}
				</Box>
				<Text color="gray" wrap="truncate-end">
					{identity}
				</Text>
				<Text color="gray" wrap="truncate-end">
					{hints}
				</Text>
			</Box>
		</Box>
	);
}

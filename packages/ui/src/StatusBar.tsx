import { Box, Text } from "ink";

export type StatusBarProps = {
	status: "offline" | "connecting" | "online";
	peerName?: string;
	peerEndpoint?: string;
	/**
	 * True while the terminal is reporting mouse events to the app. When
	 * false the host terminal handles drag-to-select natively, so we show
	 * a hint reminding the user how to flip back to wheel-scroll mode.
	 */
	mouseEnabled?: boolean;
	/**
	 * Free-form note appended after the status word, styled like the mouse
	 * hint. Used by the startup host picker, which has no peer to name yet
	 * but still needs a line of instruction.
	 */
	hint?: string;
};

export function StatusBar({
	status,
	peerName,
	peerEndpoint,
	mouseEnabled = true,
	hint,
}: StatusBarProps) {
	const statusText = {
		offline: "Offline",
		connecting: "Connecting...",
		online: `Online${peerName ? ` • ${peerName}` : ""}${peerEndpoint ? ` (${peerEndpoint})` : ""}`,
	};

	const color = status === "online" ? "green" : status === "connecting" ? "yellow" : "gray";

	// No border (used to be bordered, which cost two extra rows and stacked
	// the chat top border against another row of box drawing), but a small
	// left pad so the text doesn't sit flush against the edge while the
	// bordered chat area below starts at column 0. The width is left
	// implicit so the column-flex parent in App.tsx stretches the row to
	// the terminal width; `paddingLeft` then reserves one column from that
	// stretched width, matching the chat view's `paddingX={1}`.
	return (
		<Box paddingLeft={1}>
			<Text color={color}>{statusText[status]}</Text>
			{hint && <Text color="gray">{`  • ${hint}`}</Text>}
			{!mouseEnabled && <Text color="gray">{"  • Select mode (Ctrl+T or /mouse to scroll)"}</Text>}
		</Box>
	);
}

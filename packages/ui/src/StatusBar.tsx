import { Box, Text } from "ink";

export type StatusBarProps = {
	status: "offline" | "connecting" | "online";
	peerName?: string;
	peerEndpoint?: string;
};

export function StatusBar({ status, peerName, peerEndpoint }: StatusBarProps) {
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
		</Box>
	);
}

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

	return (
		<Box borderStyle="single" paddingX={1}>
			<Text color={color}>{statusText[status]}</Text>
		</Box>
	);
}

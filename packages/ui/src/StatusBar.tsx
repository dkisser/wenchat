import { Box, Text } from "ink";
import React from "react";

export type StatusBarProps = {
	status: "offline" | "connecting" | "online";
	peerName?: string;
};

export function StatusBar({ status, peerName }: StatusBarProps) {
	const statusText = {
		offline: "Offline",
		connecting: "Connecting...",
		online: `Online${peerName ? ` • ${peerName}` : ""}`,
	};

	const color = status === "online" ? "green" : status === "connecting" ? "yellow" : "gray";

	return (
		<Box borderStyle="single" paddingX={1}>
			<Text color={color}>{statusText[status]}</Text>
		</Box>
	);
}

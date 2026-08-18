import { Box, Text } from "ink";

export type StatusBarStatus = "offline" | "connecting" | "online";

export type StatusBarToast = {
	readonly text: string;
	/** "info" prints in dim gray (matches the existing hint palette);
	 *  "error" prints in red to flag a failure. */
	readonly tone?: "info" | "error";
};

/**
 * One-line description of the connection state, shared by StatusBar and
 * Header so the two chrome variants never drift apart in wording.
 */
export function formatStatusText(
	status: StatusBarStatus,
	peerName?: string,
	peerEndpoint?: string,
): string {
	if (status === "offline") return "Offline";
	if (status === "connecting") return "Connecting...";
	return `Online${peerName ? ` • ${peerName}` : ""}${peerEndpoint ? ` (${peerEndpoint})` : ""}`;
}

export function statusColor(status: StatusBarStatus): string {
	return status === "online" ? "green" : status === "connecting" ? "yellow" : "gray";
}

export type StatusBarProps = {
	status: StatusBarStatus;
	peerName?: string;
	peerEndpoint?: string;
	/**
	 * True while the terminal is reporting mouse events to the app. When
	 * false the host terminal handles drag-select natively, so we show
	 * a hint reminding the user how to flip back to wheel-scroll mode.
	 */
	mouseEnabled?: boolean;
	/**
	 * Free-form note appended after the status word, styled like the mouse
	 * hint. Used by the startup host picker, which has no peer to name yet
	 * but still needs a line of instruction.
	 */
	hint?: string;
	/**
	 * Transient notice shown on the right edge of the bar. The caller is
	 * responsible for timing — the bar just renders whatever it's handed
	 * and never animates or expires the value on its own.
	 */
	toast?: StatusBarToast | null;
	/** CLI version string shown after the status/hint area (e.g. "v0.1.0" or "dev"). */
	version?: string;
};

/**
 * Single-line status strip rendered above the chat viewport. When `toast`
 * is non-null it claims the right side of the row (pushing the rest of the
 * content left via `justifyContent="space-between"`), so a passing notice
 * never reflows the line height and never collides with the existing hints.
 */
export function StatusBar({
	status,
	peerName,
	peerEndpoint,
	mouseEnabled = true,
	hint,
	toast = null,
	version,
}: StatusBarProps) {
	const statusText = formatStatusText(status, peerName, peerEndpoint);
	const color = statusColor(status);

	return (
		<Box paddingLeft={1} flexDirection="row" justifyContent="space-between" width="100%">
			<Box flexShrink={1}>
				<Text color={color}>{statusText}</Text>
				{hint && <Text color="gray">{`  • ${hint}`}</Text>}
				{!mouseEnabled && (
					<Text color="gray">{"  • Select mode (Ctrl+T or /mouse to scroll)"}</Text>
				)}
				{version && <Text color="gray">{`  • ${version}`}</Text>}
			</Box>
			{toast && <Text color={toast.tone === "error" ? "red" : "gray"}>{toast.text}</Text>}
		</Box>
	);
}

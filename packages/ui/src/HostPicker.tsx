import type { BindCandidate } from "@wenchat/core";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { windowAround } from "./listWindow";

export type HostPickerProps = {
	candidates: readonly BindCandidate[];
	onSelect: (candidate: BindCandidate) => void;
	/** Port that will be bound, shown in the heading. 0 means OS-assigned. */
	signalingPort: number;
	/**
	 * Outer height in terminal rows, borders included. Omit to size to
	 * content (non-TTY output and tests).
	 */
	height?: number;
};

/** Border rows plus the heading and the key-hint footer. */
const HOST_PICKER_CHROME_ROWS = 4;

/**
 * Trailing note for the two synthetic entries. LAN rows need no note — the
 * address and NIC name already say everything.
 */
const KIND_HINTS: Record<BindCandidate["kind"], string> = {
	lan: "",
	loopback: "local only — LAN peers cannot reach you",
	any: "all interfaces",
};

/**
 * Startup picker for the address the signaling server binds and advertises.
 *
 * Shown only when the user did not pass an explicit host on the command line,
 * so that a multi-homed machine doesn't silently bind whichever NIC the OS
 * happened to enumerate first.
 */
export function HostPicker({ candidates, onSelect, signalingPort, height }: HostPickerProps) {
	const [selectedIndex, setSelectedIndex] = useState(0);

	useInput((_input, key) => {
		// Shift+Arrow belongs to the chat viewport's scrolling, so navigation
		// only claims the unmodified arrows — same split as PeerList.
		if (key.upArrow && !key.shift) {
			setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
		}
		if (key.downArrow && !key.shift) {
			setSelectedIndex((prev) => (prev < candidates.length - 1 ? prev + 1 : prev));
		}
		if (key.return && candidates[selectedIndex]) {
			onSelect(candidates[selectedIndex]);
		}
	});

	// A multi-homed host (Wi-Fi + wired + VPN + container bridges) can advertise
	// more addresses than fit; window the list so it never outgrows its box.
	const capacity =
		height === undefined ? candidates.length : Math.max(height - HOST_PICKER_CHROME_ROWS, 1);
	const { start, end } = windowAround(candidates.length, capacity, selectedIndex);
	const visible = candidates.slice(start, end);

	const portLabel = signalingPort > 0 ? String(signalingPort) : "auto";

	return (
		<Box
			flexDirection="column"
			borderStyle="single"
			paddingX={1}
			height={height}
			flexShrink={0}
			flexGrow={height === undefined ? 1 : 0}
			overflow="hidden"
		>
			<Text bold>Select bind address (port: {portLabel})</Text>
			{candidates.length === 0 && <Text color="gray">No bindable address found</Text>}
			{visible.map((candidate, index) => {
				const absoluteIndex = start + index;
				const selected = absoluteIndex === selectedIndex;
				const hint = KIND_HINTS[candidate.kind];
				return (
					<Text
						key={`${candidate.interfaceName}:${candidate.address}`}
						color={selected ? "blue" : undefined}
					>
						{selected ? "> " : "  "}
						{candidate.address}
						{candidate.interfaceName ? ` (${candidate.interfaceName})` : ""}
						{hint ? `  ${hint}` : ""}
					</Text>
				);
			})}
			<Text color="gray">↑↓ navigate · Enter to confirm</Text>
		</Box>
	);
}

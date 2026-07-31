import type { PeerInfo } from "@wenchat/protocol";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { windowAround } from "./listWindow";

export type PeerListProps = {
	peers: PeerInfo[];
	onSelect: (peer: PeerInfo) => void;
	/**
	 * Outer height in terminal rows, borders included. Omit to size to
	 * content (non-TTY output and tests).
	 */
	height?: number;
};

/** Border rows plus the "Peers" heading. */
const PEER_LIST_CHROME_ROWS = 3;

export function PeerList({ peers, onSelect, height }: PeerListProps) {
	const [selectedIndex, setSelectedIndex] = useState(0);

	useInput((_input, key) => {
		// Shift+Arrow belongs to the chat viewport's scrolling, so navigation
		// only claims the unmodified arrows — same split as InputBox.
		if (key.upArrow && !key.shift) {
			setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
		}
		if (key.downArrow && !key.shift) {
			setSelectedIndex((prev) => (prev < peers.length - 1 ? prev + 1 : prev));
		}
		if (key.return && peers[selectedIndex]) {
			onSelect(peers[selectedIndex]);
		}
	});

	// A LAN can advertise more peers than fit; window the list so it never
	// outgrows its box and pushes the InputBox off screen.
	const capacity =
		height === undefined ? peers.length : Math.max(height - PEER_LIST_CHROME_ROWS, 1);
	const { start, end } = windowAround(peers.length, capacity, selectedIndex);
	const visible = peers.slice(start, end);

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
			<Text bold>Peers</Text>
			{peers.length === 0 && <Text color="gray">No peers found</Text>}
			{visible.map((peer, index) => {
				const absoluteIndex = start + index;
				return (
					<Text key={peer.id} color={absoluteIndex === selectedIndex ? "blue" : undefined}>
						{absoluteIndex === selectedIndex ? "> " : "  "}
						{peer.displayName} ({peer.signalingHost}:{peer.signalingPort})
					</Text>
				);
			})}
		</Box>
	);
}

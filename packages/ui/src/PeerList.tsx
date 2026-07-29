import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { PeerInfo } from "@wenchat/protocol";

export type PeerListProps = {
	peers: PeerInfo[];
	onSelect: (peer: PeerInfo) => void;
};

export function PeerList({ peers, onSelect }: PeerListProps) {
	const [selectedIndex, setSelectedIndex] = useState(0);

	useInput((_input, key) => {
		if (key.upArrow) {
			setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
		}
		if (key.downArrow) {
			setSelectedIndex((prev) => (prev < peers.length - 1 ? prev + 1 : prev));
		}
		if (key.return && peers[selectedIndex]) {
			onSelect(peers[selectedIndex]);
		}
	});

	return (
		<Box flexDirection="column" borderStyle="single" paddingX={1}>
			<Text bold>Peers</Text>
			{peers.length === 0 && <Text color="gray">No peers found</Text>}
			{peers.map((peer, index) => (
				<Text key={peer.id} color={index === selectedIndex ? "blue" : undefined}>
					{index === selectedIndex ? "> " : "  "}
					{peer.displayName} ({peer.signalingHost}:{peer.signalingPort})
				</Text>
			))}
		</Box>
	);
}

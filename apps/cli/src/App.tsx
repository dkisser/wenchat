import { Box, useApp } from "ink";
import React, { useEffect, useState } from "react";
import {
	type Message,
	type PeerInfo,
	type TextMessage,
	createFileChunks,
	createFileStart,
} from "@wenchat/protocol";
import { DiscoveryService, PeerConnection } from "@wenchat/core";
import { ChatView, InputBox, PeerList, StatusBar } from "@wenchat/ui";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

export type AppProps = {
	displayName: string;
	signalingPort: number;
};

export function App({ displayName, signalingPort }: AppProps) {
	const { exit } = useApp();
	const [peers, setPeers] = useState<PeerInfo[]>([]);
	const [messages, setMessages] = useState<Message[]>([]);
	const [status, setStatus] = useState<"offline" | "connecting" | "online">(
		"offline",
	);
	const [selectedPeer, setSelectedPeer] = useState<PeerInfo | null>(null);
	const [localId] = useState(() => randomUUID());

	const [discovery] = useState(() => new DiscoveryService());
	const [peerConnection] = useState(() => new PeerConnection());

	useEffect(() => {
		discovery.onPeersUpdated(setPeers);
		discovery.start(displayName, signalingPort).catch(() => {});
		peerConnection.startListening(signalingPort).catch(() => {});
		peerConnection.onMessage((message) => {
			setMessages((prev) => [...prev, message]);
		});
		peerConnection.onStateChange((state) => {
			if (state === "connected") setStatus("online");
			else if (state === "connecting") setStatus("connecting");
			else setStatus("offline");
		});

		return () => {
			discovery.stop().catch(() => {});
			peerConnection.close();
		};
	}, [discovery, displayName, peerConnection, signalingPort]);

	const handleSelectPeer = async (peer: PeerInfo) => {
		setSelectedPeer(peer);
		setStatus("connecting");
		try {
			await peerConnection.connect(peer.signalingHost, peer.signalingPort);
		} catch {
			setStatus("offline");
		}
	};

	const handleSend = (text: string) => {
		const message: TextMessage = {
			type: "text",
			id: `${localId}-${randomUUID()}`,
			timestamp: Date.now(),
			payload: { text },
		};
		peerConnection.send(message);
		setMessages((prev) => [...prev, message]);
	};

	const handleFile = async (path: string) => {
		try {
			const file = await readFile(path);
			const chunkSize = 16 * 1024;
			const transferId = randomUUID();
			const start = createFileStart(path, file, chunkSize, transferId);
			peerConnection.send(start);
			const chunks = createFileChunks(file, chunkSize, transferId);
			for (const chunk of chunks) {
				peerConnection.send(chunk);
			}
		} catch (err) {
			setMessages((prev) => [
				...prev,
				{
					type: "text",
					id: `error-${randomUUID()}`,
					timestamp: Date.now(),
					payload: { text: `Failed to send file: ${getErrorMessage(err)}` },
				},
			]);
		}
	};

	return (
		<Box flexDirection="column" height="100%">
			<StatusBar status={status} peerName={selectedPeer?.displayName} />
			<Box flexDirection="row" flexGrow={1}>
				<PeerList peers={peers} onSelect={handleSelectPeer} />
				<ChatView messages={messages} localId={localId} />
			</Box>
			<InputBox onSubmit={handleSend} onFile={handleFile} />
		</Box>
	);
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return "Unexpected error";
}

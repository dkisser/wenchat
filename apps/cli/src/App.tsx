import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DiscoveryService, PeerConnection } from "@wenchat/core";
import {
	type Message,
	type PeerInfo,
	type TextMessage,
	createFileChunks,
	createFileStart,
} from "@wenchat/protocol";
import { ChatView, CommandSuggestion, InputBox, PeerList, StatusBar } from "@wenchat/ui";
import { Box, useApp } from "ink";
import { useEffect, useState } from "react";

export type AppProps = {
	displayName: string;
	signalingPort: number;
};

export function App({ displayName, signalingPort }: AppProps) {
	const { exit } = useApp();
	const [peers, setPeers] = useState<PeerInfo[]>([]);
	const [messages, setMessages] = useState<Message[]>([]);
	const [status, setStatus] = useState<"offline" | "connecting" | "online">("offline");
	const [selectedPeer, setSelectedPeer] = useState<PeerInfo | null>(null);
	const [inputText, setInputText] = useState("");
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

	const appendSystemMessage = (text: string) => {
		const message: TextMessage = {
			type: "text",
			id: `system-${randomUUID()}`,
			timestamp: Date.now(),
			payload: { text },
		};
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
			appendSystemMessage(`Failed to send file: ${getErrorMessage(err)}`);
		}
	};

	const handleHelp = () => {
		appendSystemMessage("Magic commands: /exit, /file <path>, /help, /connect <host:port>");
	};

	const handleExit = () => {
		peerConnection.close();
		discovery.stop().catch(() => {});
		exit();
	};

	const handleConnect = async (hostPort: string) => {
		const lastColon = hostPort.lastIndexOf(":");
		if (lastColon <= 0 || lastColon === hostPort.length - 1) {
			appendSystemMessage(`Invalid /connect argument: expected <host:port>, got "${hostPort}"`);
			return;
		}
		const host = hostPort.slice(0, lastColon);
		const port = Number(hostPort.slice(lastColon + 1));
		if (!Number.isFinite(port) || port <= 0 || port > 65535) {
			appendSystemMessage(`Invalid /connect argument: port out of range in "${hostPort}"`);
			return;
		}
		setSelectedPeer({
			id: "manual",
			displayName: hostPort,
			signalingHost: host,
			signalingPort: port,
		});
		setStatus("connecting");
		try {
			await peerConnection.connect(host, port);
		} catch {
			setStatus("offline");
			appendSystemMessage(`Failed to connect to ${hostPort}`);
		}
	};

	const handleCommand = (name: string, arg: string) => {
		switch (name) {
			case "exit":
				handleExit();
				return;
			case "file":
				void handleFile(arg);
				return;
			case "help":
				handleHelp();
				return;
			case "connect":
				void handleConnect(arg);
				return;
		}
	};

	const handleUnknownCommand = (name: string, _arg: string) => {
		appendSystemMessage(`Unknown command: /${name}. Type /help for the list.`);
	};

	return (
		<Box flexDirection="column" height="100%">
			<StatusBar status={status} peerName={selectedPeer?.displayName} />
			<Box flexDirection="row" flexGrow={1}>
				<PeerList peers={peers} onSelect={handleSelectPeer} />
				<ChatView messages={messages} localId={localId} />
			</Box>
			<CommandSuggestion partial={inputText} />
			<InputBox
				value={inputText}
				onChange={setInputText}
				onSubmit={handleSend}
				onCommand={handleCommand}
				onUnknownCommand={handleUnknownCommand}
			/>
		</Box>
	);
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return "Unexpected error";
}

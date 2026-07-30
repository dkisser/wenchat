import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { DiscoveryService, PeerConnection } from "@wenchat/core";
import {
	type Message,
	type PeerInfo,
	type TextMessage,
	createFileChunks,
	createFileStart,
} from "@wenchat/protocol";
import {
	ChatView,
	CommandSuggestion,
	DEFAULT_DOWNLOAD_DIR,
	FileReceiver,
	InputBox,
	PeerList,
	StatusBar,
	saveCompletedTransfer,
} from "@wenchat/ui";
import { Box, useApp } from "ink";
import { useEffect, useRef, useState } from "react";

export type AppProps = {
	displayName: string;
	signalingPort: number;
	signalingHost: string;
};

export function App({ displayName, signalingPort, signalingHost }: AppProps) {
	const { exit } = useApp();
	const [peers, setPeers] = useState<PeerInfo[]>([]);
	const [messages, setMessages] = useState<Message[]>([]);
	const [status, setStatus] = useState<"offline" | "connecting" | "online">("offline");
	const [selectedPeer, setSelectedPeer] = useState<PeerInfo | null>(null);
	const [inputText, setInputText] = useState("");
	const [localId] = useState(() => randomUUID());

	const [discovery] = useState(() => new DiscoveryService());
	const [peerConnection] = useState(() => new PeerConnection());
	const fileReceiverRef = useRef(new FileReceiver());

	useEffect(() => {
		discovery.onPeersUpdated(setPeers);
		discovery.start(displayName, signalingPort, signalingHost).catch(() => {});
		peerConnection.startListening(signalingPort, signalingHost).catch(() => {});
		peerConnection.onMessage((message) => {
			setMessages((prev) => [...prev, message]);

			if (message.type === "file-start") {
				fileReceiverRef.current.onStart(message);
			} else if (message.type === "file-chunk") {
				const completed = fileReceiverRef.current.onChunk(message);
				if (completed) {
					void saveCompletedTransfer(DEFAULT_DOWNLOAD_DIR, completed)
						.then((path) => {
							appendSystemMessage(`Saved file: ${path}`);
						})
						.catch((err: unknown) => {
							appendSystemMessage(`Failed to save file: ${getErrorMessage(err)}`);
						});
				}
			}
		});
		peerConnection.onStateChange((state) => {
			if (state === "connected") setStatus("online");
			else if (state === "connecting") setStatus("connecting");
			else setStatus("offline");
		});

		return () => {
			fileReceiverRef.current.clear();
			discovery.stop().catch(() => {});
			peerConnection.close();
		};
	}, [discovery, displayName, peerConnection, signalingPort, signalingHost]);

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
			// Pre-flight check so missing files short-circuit before we touch
			// the data channel. Any error thrown here means nothing has been
			// sent to the peer yet — the receiver's ChatView stays untouched.
			await access(path);
			const file = await readFile(path);
			const chunkSize = 16 * 1024;
			const transferId = randomUUID();
			// Send only the basename over the wire so the receiver never
			// learns where the file lives on our disk.
			const displayName = basename(path);
			const start = createFileStart(displayName, file, chunkSize, transferId);
			peerConnection.send(start);
			const chunks = createFileChunks(file, chunkSize, transferId);
			for (const chunk of chunks) {
				peerConnection.send(chunk);
			}
		} catch (err) {
			if (isErrnoException(err) && err.code === "ENOENT") {
				appendSystemMessage(`File doesn't exist: ${path}`);
			} else if (isErrnoException(err) && err.code === "EACCES") {
				appendSystemMessage(`Cannot read file (permission denied): ${path}`);
			} else {
				appendSystemMessage(`Failed to send file: ${getErrorMessage(err)}`);
			}
		}
	};

	const handleHelp = () => {
		appendSystemMessage("Magic commands: /exit, /file <path>, /help, /connect <host:port>");
	};

	const handleExit = () => {
		peerConnection.close();
		discovery.stop().catch(() => {});
		// Ink's `exit()` triggers App's componentWillUnmount → final onRender
		// → cliCursor.show. After the React tree fully unmounts,
		// `instance.waitUntilExit()` in main.tsx resolves and writes the
		// alternate-screen exit sequence before terminating the process.
		// We intentionally do NOT call `process.exit()` here — leaving the
		// shutdown sequencing to main.tsx keeps the alternate buffer release
		// and the process exit in the same microtask, so the host terminal
		// never sees a half-rendered final frame.
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

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}

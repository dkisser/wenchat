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
	computeChatLayout,
	isCommandSuggestionVisible,
	saveCompletedTransfer,
	useChatScroll,
	useTerminalSize,
} from "@wenchat/ui";
import { Box, useApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { isMouseModeEnabled, toggleMouseMode } from "./mouseMode";

export type AppProps = {
	displayName: string;
	signalingPort: number;
	signalingHost: string;
	/**
	 * Test-only: seed the chat log with an initial message so render
	 * branches that depend on `messages.length` can be asserted in
	 * isolation. Defaults to empty.
	 */
	initialMessages?: readonly Message[];
};

/**
 * Upper bound on the retained chat log. Without a cap, `toDisplayLines` has to
 * re-wrap an ever-growing array on every resize and the process leaks memory
 * across a long-lived session.
 */
const MAX_MESSAGES = 2000;

export function App({ displayName, signalingPort, signalingHost, initialMessages = [] }: AppProps) {
	const { exit } = useApp();
	const [peers, setPeers] = useState<PeerInfo[]>([]);
	const [messages, setMessages] = useState<Message[]>([...initialMessages]);
	const [status, setStatus] = useState<"offline" | "connecting" | "online">("offline");
	const [selectedPeer, setSelectedPeer] = useState<PeerInfo | null>(null);
	const [inputText, setInputText] = useState("");
	// `main.tsx` may have already entered mouse mode (TTY, no `--no-mouse`);
	// seed React state from the actual terminal state so the first render
	// matches reality instead of always rendering "Select mode".
	const [mouseEnabled, setMouseEnabled] = useState(() => isMouseModeEnabled());
	const [localId] = useState(() => randomUUID());

	const [discovery] = useState(() => new DiscoveryService());
	const [peerConnection] = useState(() => new PeerConnection());
	const fileReceiverRef = useRef(new FileReceiver());

	// Monotonic counter incremented on every connect/disconnect. Each
	// in-flight `connect()` captures its own generation and bails out
	// (without swapping in its session or surfacing errors) if a later
	// generation has been started — otherwise a `/disconnect` issued while
	// a handshake is in flight could be silently undone when the late
	// `await` resolves and re-installs the session under our feet.
	const connectionGenerationRef = useRef(0);

	// Mirror `selectedPeer` into a ref so that the long-lived `onStateChange`
	// closure — which is registered once on mount — always sees the latest
	// peer info when emitting "Connected to …" / "Lost connection to …"
	// system messages. Without this, the closure would capture whichever peer
	// was selected at mount time (typically null) and never observe clicks.
	const selectedPeerRef = useRef<PeerInfo | null>(null);
	useEffect(() => {
		selectedPeerRef.current = selectedPeer;
	}, [selectedPeer]);

	// Same mirror for the discovery list: the long-lived `onIncoming`
	// closure (registered once on mount) needs the latest `peers` to look
	// up an incoming connection against the mDNS-discovered roster.
	const peersRef = useRef<PeerInfo[]>([]);
	useEffect(() => {
		peersRef.current = peers;
	}, [peers]);

	// Ctrl+T toggles mouse reporting at the terminal level. While tracking
	// is on the host terminal swallows drag-select, so users flip it off
	// (and back on) to copy text out of the chat log. Ctrl+T was picked
	// over the more discoverable Alt+M because macOS Terminal maps Alt
	// to menu-bar navigation — every Alt combo is eaten before the TUI
	// ever sees it. Ctrl+T is also exposed as a `/mouse` magic command
	// for users who can't (or don't want to) remember the binding.
	useInput((input, key) => {
		if (!key.ctrl || input !== "t") return;
		toggleMouseMode();
		setMouseEnabled(isMouseModeEnabled());
	});

	useEffect(() => {
		discovery.onPeersUpdated(setPeers);
		discovery.start(displayName, signalingPort, signalingHost).catch(() => {});
		peerConnection.startListening(signalingPort, signalingHost).catch(() => {});
		const unsubscribeIncoming = peerConnection.onIncoming(({ signalingHost, signalingPort }) => {
			// Receiver side: someone is dialing us. Resolve the
			// signaling endpoint to a PeerInfo (either a discovered
			// peer or a synthetic fallback), seed both the ref and
			// the React state so the upcoming `onStateChange("connected")`
			// branch sees a peer, and flip status to "connecting" for
			// parity with the initiator's path. Writing
			// `selectedPeerRef.current` synchronously here closes the
			// race with werift's async `onconnectionstatechange`.
			// TODO: multi-session handoff — if a session is already
			// active when a new offer arrives, the outgoing session's
			// terminal event will fire under the new peer's identity.
			const peer = resolveIncomingPeer(peersRef.current, signalingHost, signalingPort);
			selectedPeerRef.current = peer;
			setSelectedPeer(peer);
			setStatus("connecting");
		});
		const unsubscribeMessage = peerConnection.onMessage((message) => {
			setMessages((prev) => appendCapped(prev, message));

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
		const unsubscribeState = peerConnection.onStateChange((state) => {
			const peer = selectedPeerRef.current;
			if (state === "connected") {
				setStatus("online");
				if (peer) {
					const endpoint = `${peer.signalingHost}:${peer.signalingPort}`;
					const text =
						peer.id === "manual"
							? `Connected to ${endpoint}`
							: `Connected to ${peer.displayName} (${endpoint})`;
					appendSystemMessage(text);
				}
			} else if (state === "connecting") {
				setStatus("connecting");
			} else {
				// Terminal state (disconnected/closed/failed). PeerConnection
				// guards with a `terminated` flag so we only see one of these
				// per connection attempt, so it's safe to emit a system
				// message every time.
				setStatus("offline");
				if (peer) {
					const endpoint = `${peer.signalingHost}:${peer.signalingPort}`;
					const text =
						peer.id === "manual"
							? `Lost connection to ${endpoint}`
							: `Lost connection to ${peer.displayName} (${endpoint})`;
					appendSystemMessage(text);
				}
				// Drop the stale peer name so StatusBar doesn't keep showing
				// "Offline • <oldPeer>" after the peer goes away.
				setSelectedPeer(null);
			}
		});

		return () => {
			unsubscribeIncoming();
			unsubscribeMessage();
			unsubscribeState();
			fileReceiverRef.current.clear();
			discovery.stop().catch(() => {});
			peerConnection.close();
		};
	}, [discovery, displayName, peerConnection, signalingPort, signalingHost]);

	const handleSelectPeer = async (peer: PeerInfo) => {
		// Re-selecting a peer (or any other peer) while already connected
		// would have flipped the status to "connecting" and torn down the
		// live session inside `peerConnection.connect()`. Reject the click
		// and ask the user to /disconnect first so the active chat isn't
		// silently dropped on them.
		if (status === "online" || status === "connecting") {
			appendSystemMessage("Already connected. Run /disconnect first to switch peer.");
			return;
		}
		setSelectedPeer(peer);
		setStatus("connecting");
		const myGeneration = ++connectionGenerationRef.current;
		try {
			await peerConnection.connect(peer.signalingHost, peer.signalingPort);
			if (connectionGenerationRef.current !== myGeneration) return;
		} catch {
			if (connectionGenerationRef.current !== myGeneration) return;
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
		try {
			peerConnection.send(message);
		} catch {
			// No active session — typically the remote side already
			// /exited. Surface this as a system message instead of
			// letting the throw escape the React event callback and
			// tear down the Ink render tree.
			appendSystemMessage("Not connected");
			return;
		}
		setMessages((prev) => appendCapped(prev, message));
	};

	const appendSystemMessage = (text: string) => {
		const message: TextMessage = {
			type: "text",
			id: `system-${randomUUID()}`,
			timestamp: Date.now(),
			payload: { text },
		};
		setMessages((prev) => appendCapped(prev, message));
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
		appendSystemMessage(
			"Magic commands: /exit, /disconnect, /mouse, /file <path>, /help, /connect <host:port>",
		);
	};

	const handleDisconnect = () => {
		// Bump the generation BEFORE the synchronous state reset so any
		// in-flight `connect()` await sees a stale token and bails out
		// without re-installing its session under us.
		connectionGenerationRef.current++;
		const peer = selectedPeerRef.current;
		if (!peer) {
			appendSystemMessage("Not connected");
			return;
		}
		// Tear down the active session but leave the signaling server up so
		// the user can dial out (or accept an offer) again. The remote peer
		// observes the close on its pc and its own listener emits
		// "Lost connection to …" — this side emits the matching
		// "Disconnected from …" so both sides see a notice.
		peerConnection.disconnect();
		setStatus("offline");
		setSelectedPeer(null);
		const endpoint = `${peer.signalingHost}:${peer.signalingPort}`;
		const text =
			peer.id === "manual"
				? `Disconnected from ${endpoint}`
				: `Disconnected from ${peer.displayName} (${endpoint})`;
		appendSystemMessage(text);
	};

	const handleExit = () => {
		// Emit the disconnect notice FIRST so the local chat log records the
		// close, mirroring what the remote peer will see via its own
		// onStateChange("closed") handler. The teardown that follows
		// (peerConnection.close + exit) detaches the listeners so this
		// doesn't race with the "Lost connection to …" path on the way out.
		const peer = selectedPeerRef.current;
		if (peer) {
			const endpoint = `${peer.signalingHost}:${peer.signalingPort}`;
			const text =
				peer.id === "manual"
					? `Disconnected from ${endpoint}`
					: `Disconnected from ${peer.displayName} (${endpoint})`;
			appendSystemMessage(text);
		}
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
		if (status === "online" || status === "connecting") {
			appendSystemMessage("Already connected. Run /disconnect first to switch peer.");
			return;
		}
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
		const myGeneration = ++connectionGenerationRef.current;
		try {
			await peerConnection.connect(host, port);
			if (connectionGenerationRef.current !== myGeneration) return;
		} catch {
			if (connectionGenerationRef.current !== myGeneration) return;
			setStatus("offline");
			appendSystemMessage(`Failed to connect to ${hostPort}`);
		}
	};

	const handleMouse = () => {
		// Toggle the terminal-level mouse reporting flag and mirror it
		// into React state so the StatusBar indicator updates. We don't
		// surface a system message — the bar's "Select mode" hint is the
		// visible feedback and we don't want to spam the chat log on
		// every flip.
		toggleMouseMode();
		setMouseEnabled(isMouseModeEnabled());
	};

	const handleCommand = (name: string, arg: string) => {
		switch (name) {
			case "exit":
				handleExit();
				return;
			case "disconnect":
				handleDisconnect();
				return;
			case "mouse":
				handleMouse();
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

	const { rows, columns } = useTerminalSize();
	const layout = computeChatLayout({
		rows,
		columns,
		suggestionVisible: isCommandSuggestionVisible(inputText),
	});

	const scroll = useChatScroll({
		messages,
		localId,
		contentWidth: layout.contentWidth,
		viewportHeight: layout.viewportHeight,
		// Scroll keys stay active whenever the ChatView is on screen —
		// including the post-disconnect case where `status` is "offline"
		// but `messages.length > 0` keeps the history visible. The
		// PeerList path still gets inactive scroll input.
		isActive: status !== "offline" || messages.length > 0,
	});

	return (
		// A numeric height is the only thing that pins the InputBox to the last
		// row: ink's root node never gets a height (see `ink/build/ink.js`), so
		// `height="100%"` silently resolved to `auto` and the frame grew with the
		// message log until the input scrolled off screen.
		//
		// Every direct child needs `flexShrink={0}`. Under a height-constrained
		// column, yoga shrinks Text children until their rows overlap and
		// overwrite one another — visible garbage, not clipping.
		<Box flexDirection="column" height={layout.frameHeight}>
			<Box flexShrink={0}>
				<StatusBar
					status={status}
					peerName={selectedPeer?.displayName}
					peerEndpoint={
						selectedPeer ? `${selectedPeer.signalingHost}:${selectedPeer.signalingPort}` : undefined
					}
					mouseEnabled={mouseEnabled}
				/>
			</Box>
			{status === "offline" && messages.length === 0 ? (
				<PeerList peers={peers} onSelect={handleSelectPeer} height={layout.chatOuterHeight} />
			) : (
				<ChatView
					lines={scroll.visibleLines}
					firstLineIndex={scroll.firstLineIndex}
					unread={scroll.unread}
					height={layout.chatOuterHeight}
				/>
			)}
			<Box flexShrink={0}>
				<CommandSuggestion partial={inputText} />
			</Box>
			<Box flexShrink={0}>
				<InputBox
					value={inputText}
					onChange={setInputText}
					onSubmit={handleSend}
					onCommand={handleCommand}
					onUnknownCommand={handleUnknownCommand}
					onError={(err) => appendSystemMessage(`History unavailable: ${getErrorMessage(err)}`)}
				/>
			</Box>
		</Box>
	);
}

/**
 * Append a message, dropping the oldest once the log exceeds
 * {@link MAX_MESSAGES}. Returns a new array — the previous one is untouched.
 */
function appendCapped(previous: readonly Message[], message: Message): Message[] {
	const next = [...previous, message];
	return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
}

/**
 * Resolve a PeerInfo for an incoming offer's signaling endpoint.
 * Matches on strict (signalingHost, signalingPort) equality against
 * the current discovery list. If no entry matches, returns a synthetic
 * PeerInfo so the UI can still name the connection — `"<host>:<port>"`
 * if we have an endpoint, otherwise `"unknown peer"` (older initiator
 * that didn't populate the offer's signalingHost/Port).
 */
function resolveIncomingPeer(
	peers: readonly PeerInfo[],
	signalingHost: string,
	signalingPort: number,
): PeerInfo {
	const match = peers.find(
		(p) => p.signalingHost === signalingHost && p.signalingPort === signalingPort,
	);
	if (match) return match;
	const label =
		signalingHost && signalingPort > 0 ? `${signalingHost}:${signalingPort}` : "unknown peer";
	return {
		id: "incoming",
		displayName: label,
		signalingHost,
		signalingPort,
	};
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

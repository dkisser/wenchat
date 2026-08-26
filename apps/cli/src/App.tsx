import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { basename } from "node:path";
import {
	type BindCandidate,
	DiscoveryService,
	FileReceiver,
	PeerConnection,
	type TransferEvent,
	getLogFilePath,
	getLogger,
	listBindCandidates,
	resolveAdvertiseHost,
} from "@wenchat/core";
import { type Message, type PeerInfo, type TextMessage, createFileAbort } from "@wenchat/protocol";
import {
	CHROME_ROWS,
	ChatView,
	CommandSuggestion,
	FileSuggestion,
	Header,
	HostPicker,
	InputBox,
	MIN_LOGO_HEADER_COLUMNS,
	PeerList,
	StatusBar,
	type StatusBarToast,
	computeChatLayout,
	expandTilde,
	findMessageAtLine,
	formatBytes,
	isCommandSuggestionVisible,
	useChatScroll,
	useDoubleClick,
	useFileCompletion,
	useTerminalSize,
} from "@wenchat/ui";
import { Box, Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyToClipboard } from "./clipboard";
import { isMouseModeEnabled, toggleMouseMode } from "./mouseMode";
import { getCurrentVersion } from "./updater";

export type AppProps = {
	displayName: string;
	signalingPort: number;
	/**
	 * Bind address. When omitted the app opens on the startup host picker
	 * instead of going straight to the peer list — `main.tsx` leaves it
	 * undefined only for an interactive run that got no explicit host
	 * argument.
	 */
	signalingHost?: string;
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

// First slot is short ("Wi-Fi blip" — most transients recover inside
// ~1 s); the trailing 10 s slots carry the "they're really gone"
// stretch. Five attempts × ~28 s of wall-clock buys enough time to
// ride out an access-point roam without stranding the user staring
// at a spinner forever. The give-up message in `scheduleReconnect`
// tells them what to try next.
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 10000] as const;
const MAX_RECONNECT_ATTEMPTS = RECONNECT_BACKOFF_MS.length;

export function App({ displayName, signalingPort, signalingHost, initialMessages = [] }: AppProps) {
	const { exit } = useApp();
	const [peers, setPeers] = useState<PeerInfo[]>([]);
	const [messages, setMessages] = useState<Message[]>([...initialMessages]);
	const [status, setStatus] = useState<"offline" | "connecting" | "reconnecting" | "online">(
		"offline",
	);
	const [selectedPeer, setSelectedPeer] = useState<PeerInfo | null>(null);
	const [inputText, setInputText] = useState("");
	// `main.tsx` may have already entered mouse mode (TTY, no `--no-mouse`);
	// seed React state from the actual terminal state so the first render
	// matches reality instead of always rendering "Select mode".
	const [mouseEnabled, setMouseEnabled] = useState(() => isMouseModeEnabled());
	const [localId] = useState(() => randomUUID());

	// null until the user picks an address in the startup HostPicker. A
	// caller-supplied `signalingHost` seeds it directly, which skips the
	// picker entirely and preserves the explicit
	// `cli <name> <port> <host>` invocation.
	const [bindHost, setBindHost] = useState<string | null>(signalingHost ?? null);
	const [candidates] = useState(() => listBindCandidates());
	// "host:port" the Header's identity line shows once the signaling
	// listener is actually bound. Stays null until then — and forever if the
	// bind fails — so the identity line just omits the endpoint segment.
	const [localEndpoint, setLocalEndpoint] = useState<string | null>(null);

	const [discovery] = useState(() => new DiscoveryService());
	const [peerConnection] = useState(() => new PeerConnection());

	// Monotonic counter incremented on every connect/disconnect. Each
	// in-flight `connect()` captures its own generation and bails out
	// (without swapping in its session or surfacing errors) if a later
	// generation has been started — otherwise a `/disconnect` issued while
	// a handshake is in flight could be silently undone when the late
	// `await` resolves and re-installs the session under our feet.
	const connectionGenerationRef = useRef(0);

	// Snapshot of the last peer we initiated a session with (PeerList
	// click or `/connect`). Survives the React state reset we do on
	// terminal states, so `/reconnect` can redial without the user
	// having to remember host:port. Only written for OUTBOUND calls —
	// an incoming offer is not "the peer we wanted to talk to".
	const lastPeerRef = useRef<PeerInfo | null>(null);

	// 1-based. Reset to 0 on `connected` or on any user cancel. Read by
	// `formatReconnectNotice` to render "(attempt 2/5)" and by the
	// backoff scheduler to pick the next slot.
	const reconnectAttemptRef = useRef(0);

	// `setTimeout` handle for the pending reconnect. `null` means no
	// reconnect is queued. Cleared by `cancelReconnectTimer`, by user
	// actions that change targets (`/disconnect`, `/cancel`, picking a
	// different peer), and by the useEffect cleanup on unmount.
	const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
		// Nothing is bound or advertised until the user picks an address.
		// Returning `undefined` (not a bare `return`) keeps every code path
		// returning a value, which `noImplicitReturns` requires once the
		// other path returns a cleanup.
		if (bindHost === null) return undefined;

		// Binding 0.0.0.0 is legitimate, but publishing it is not: a peer
		// reading "0.0.0.0" out of our mDNS TXT record would dial its own
		// loopback. Advertise a concrete address in that case.
		const advertiseHost = resolveAdvertiseHost(bindHost);

		// Subscribe BEFORE we kick off discovery so any peer "up" event
		// that races ahead of `discovery.start` resolving is delivered to
		// the React state. Capture the unsubscriber so the cleanup can
		// detach it (previously this fired-and-forgot the registration,
		// which is fine on mount but leaks if `bindHost` ever changes).
		const unsubscribePeers = discovery.onPeersUpdated(setPeers);

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
			//
			// An inbound offer while we're auto-redialing means the
			// remote beat us to the punch (or our cached host:port is
			// stale). Cancel the retry so the two handshakes don't race;
			// their offer completes on the next microtask.
			if (reconnectTimerRef.current !== null) {
				cancelReconnectTimer();
				reconnectAttemptRef.current = 0;
				connectionGenerationRef.current++;
			}
			const peer = resolveIncomingPeer(peersRef.current, signalingHost, signalingPort);
			selectedPeerRef.current = peer;
			setSelectedPeer(peer);
			setStatus("connecting");
		});
		const unsubscribeMessage = peerConnection.onMessage((message) => {
			if (message.type === "text") {
				setMessages((prev) => appendCapped(prev, message));
				return;
			}
			// File control messages never enter the chat log — a 100 MiB
			// transfer would otherwise push thousands of chunk-carrying
			// messages into React state and re-render on every one. They feed
			// the streaming receiver, whose events surface as system entries.
			fileReceiver.handleMessage(message);
		});
		// Chunks arrive on their own channel (binary frames demuxed by the
		// transport) — straight into the receiver, never near React state.
		const unsubscribeChunks = peerConnection.onFileChunk((chunk) => {
			fileReceiver.handleChunk(chunk);
		});
		const unsubscribeState = peerConnection.onStateChange((state) => {
			const peer = selectedPeerRef.current;
			if (state === "connected") {
				setStatus("online");
				reconnectAttemptRef.current = 0;
				cancelReconnectTimer();
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
				//
				// PeerConnection detaches its forwarders before `/disconnect`
				// closes the session, so we NEVER see a terminal here for a
				// manual teardown — every entry is network-driven. File the
				// peer for auto-redial and keep `selectedPeer` set so the
				// StatusBar can still name the target during the retry
				// window. `lastPeerRef` survives even if the user later
				// nulls out `selectedPeer` via the give-up path, so
				// `/reconnect` can still redial.
				if (peer) {
					lastPeerRef.current = peer;
					reconnectAttemptRef.current = 1;
					setStatus("reconnecting");
					scheduleReconnect(peer);
				} else {
					setStatus("offline");
				}
				// Any in-flight incoming transfer is now hopeless — clean up
				// its temp file and emit a "failed" system entry per transfer.
				void fileReceiver.dispose();
			}
		});

		// Sequence the two starts so the mDNS publish carries the *real*
		// bound port — not whatever value the caller passed in (typically
		// `0`, "let the OS pick"). Publishing port 0 leaves LAN peers
		// with no dial target: `parseService` drops a record whose
		// `signalingPort` and SRV `port` are both `<= 0`, so neither side
		// ever sees the other in its peer list. Sequencing is the fix.
		let cancelled = false;
		void (async () => {
			try {
				await peerConnection.startListening(signalingPort, bindHost, advertiseHost);
				if (cancelled) return;
				const realPort = peerConnection.getSignalingPort();
				if (realPort > 0) setLocalEndpoint(`${advertiseHost}:${realPort}`);
				await discovery.start(displayName, realPort, advertiseHost);
			} catch (err) {
				// Never write to stderr here — it would corrupt the alt-screen
				// frame. The daily log file gets the full detail instead, and
				// the user gets a system message pointing at it.
				getLogger().error({ err }, "signaling/discovery startup failed");
				appendSystemMessage(
					`Failed to start on ${bindHost}:${signalingPort} — details in ${getLogFilePath()}`,
				);
			}
		})();

		return () => {
			cancelled = true;
			if (reconnectTimerRef.current !== null) {
				clearTimeout(reconnectTimerRef.current);
				reconnectTimerRef.current = null;
			}
			unsubscribePeers();
			unsubscribeIncoming();
			unsubscribeMessage();
			unsubscribeChunks();
			unsubscribeState();
			void fileReceiver.dispose();
			discovery.stop().catch(() => {});
			peerConnection.close();
		};
	}, [discovery, displayName, peerConnection, signalingPort, bindHost]);

	const handleSelectPeer = async (peer: PeerInfo) => {
		// Re-selecting a peer (or any other peer) while already connected
		// would have flipped the status to "connecting" and torn down the
		// live session inside `peerConnection.connect()`. Reject the click
		// and ask the user to /disconnect first so the active chat isn't
		// silently dropped on them. "reconnecting" is treated the same as
		// the active states — picking a new target cancels the auto-retry.
		if (status === "online" || status === "connecting" || status === "reconnecting") {
			appendSystemMessage("Already connected. Run /disconnect first to switch peer.");
			return;
		}
		cancelReconnectTimer();
		reconnectAttemptRef.current = 0;
		setSelectedPeer(peer);
		lastPeerRef.current = peer;
		setStatus("connecting");
		const myGeneration = ++connectionGenerationRef.current;
		try {
			await peerConnection.connect(peer.signalingHost, peer.signalingPort);
			if (connectionGenerationRef.current !== myGeneration) return;
		} catch {
			if (connectionGenerationRef.current !== myGeneration) return;
			setStatus("offline");
			appendSystemMessage(
				`Failed to connect to ${peer.displayName} (${peer.signalingHost}:${peer.signalingPort})`,
			);
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

	const handleFile = async (path: string) => {
		const expanded = expandTilde(path);
		try {
			// Pre-flight check so missing files short-circuit before we touch
			// the data channel. Any error thrown here means nothing has been
			// sent to the peer yet — the receiver's ChatView stays untouched.
			await access(expanded);
			// Send only the basename over the wire so the receiver never
			// learns where the file lives on our disk.
			const displayName = basename(expanded);
			appendSystemMessage(`Sending ${displayName}…`);
			const result = await peerConnection.sendFile(expanded, {
				onProgress: (sent, total) => {
					if (total > 0) {
						showTransferProgress(`Sending ${displayName} — ${Math.round((sent / total) * 100)}%`);
					}
				},
			});
			appendSystemMessage(`Sent file: ${displayName} (${formatBytes(result.bytesSent)})`);
		} catch (err) {
			if (isErrnoException(err) && err.code === "ENOENT") {
				appendSystemMessage(`File doesn't exist: ${expanded}`);
			} else if (isErrnoException(err) && err.code === "EACCES") {
				appendSystemMessage(`Cannot read file (permission denied): ${expanded}`);
			} else {
				appendSystemMessage(
					`Failed to send file: ${getErrorMessage(err)} (logs: ${getLogFilePath()})`,
				);
			}
		}
	};

	const handleHelp = () => {
		appendSystemMessage(
			"Magic commands: /exit, /disconnect, /reconnect, /cancel, /mouse, /file <path>, /help, /connect <host:port>, /copy [n]",
		);
	};

	const handleDisconnect = () => {
		cancelReconnectTimer();
		reconnectAttemptRef.current = 0;
		// Bump the generation BEFORE the synchronous state reset so any
		// in-flight `connect()` await sees a stale token and bails out
		// without re-installing its session under us — including a
		// /reconnect attempt that was about to fire its timer.
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
		cancelReconnectTimer();
		reconnectAttemptRef.current = 0;
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
		if (status === "online" || status === "connecting" || status === "reconnecting") {
			appendSystemMessage("Already connected. Run /disconnect first to switch peer.");
			return;
		}
		cancelReconnectTimer();
		reconnectAttemptRef.current = 0;
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
		const manualPeer: PeerInfo = {
			id: "manual",
			displayName: hostPort,
			signalingHost: host,
			signalingPort: port,
		};
		setSelectedPeer(manualPeer);
		lastPeerRef.current = manualPeer;
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

	// Manually redial the last peer we talked to. Failures here do NOT
	// trigger the auto-redial loop — user-initiated dials need predictable
	// feedback, not a quiet retry storm. `lastPeerRef` is intentionally
	// preserved across the offline gap by `onStateChange`, so even if the
	// auto-redial already gave up the user can still call this.
	const handleReconnect = async () => {
		const peer = lastPeerRef.current;
		if (!peer) {
			appendSystemMessage(
				"No previous peer. Use /connect <host:port> or pick a peer from the list.",
			);
			return;
		}
		if (status === "online" || status === "connecting" || status === "reconnecting") {
			appendSystemMessage("Already connected. Run /disconnect first to switch peer.");
			return;
		}
		cancelReconnectTimer();
		reconnectAttemptRef.current = 0;
		setSelectedPeer(peer);
		setStatus("connecting");
		const myGeneration = ++connectionGenerationRef.current;
		try {
			await peerConnection.connect(peer.signalingHost, peer.signalingPort);
			if (connectionGenerationRef.current !== myGeneration) return;
		} catch {
			if (connectionGenerationRef.current !== myGeneration) return;
			setStatus("offline");
			const label =
				peer.id === "manual" ? `${peer.signalingHost}:${peer.signalingPort}` : peer.displayName;
			appendSystemMessage(`Failed to reconnect to ${label}`);
		}
	};

	// Abort a pending auto-reconnect. Keeps `lastPeerRef` so the user can
	// retry with `/reconnect` later — we only stop the timer, we don't
	// forget the target.
	const handleCancel = () => {
		if (reconnectTimerRef.current === null) {
			appendSystemMessage("No reconnect in progress.");
			return;
		}
		cancelReconnectTimer();
		reconnectAttemptRef.current = 0;
		setStatus("offline");
		appendSystemMessage("Reconnect cancelled.");
	};

	const handleCommand = (name: string, arg: string) => {
		switch (name) {
			case "exit":
				handleExit();
				return;
			case "disconnect":
				handleDisconnect();
				return;
			case "reconnect":
				void handleReconnect();
				return;
			case "cancel":
				handleCancel();
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
			case "copy":
				handleCopy(arg);
				return;
		}
	};

	// Walk messages backwards, picking the n-th text message (1-based).
	// The chat log only ever holds text messages — file control traffic
	// and heartbeats feed the receiver/scheduler directly — so every
	// entry here increments the counter.
	const handleCopy = (arg: string) => {
		const trimmed = arg.trim();
		let n = 1;
		if (trimmed.length > 0) {
			const parsed = Number.parseInt(trimmed, 10);
			if (!Number.isFinite(parsed) || parsed < 1) {
				appendSystemMessage(`Invalid /copy argument: expected positive integer, got "${arg}"`);
				return;
			}
			n = parsed;
		}
		let found: TextMessage | null = null;
		let seen = 0;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (!message || message.type !== "text") continue;
			seen++;
			if (seen === n) {
				found = message;
				break;
			}
		}
		if (!found) {
			appendSystemMessage(
				`No message at position ${n} (only ${seen} text message${seen === 1 ? "" : "s"} in log)`,
			);
			return;
		}
		copyAndReport(found.payload.text);
	};

	const { rows, columns } = useTerminalSize();
	// Inline fuzzy picker for `/file <partial>`. While it's active it owns
	// ↑/↓/Enter/Esc (via the InputBox completion prop) and replaces the
	// command suggestion row — stacking both would cost nine rows of chrome.
	const fileCompletion = useFileCompletion({ input: inputText, onChange: setInputText });
	// The logo masthead needs its 38 columns plus room for the info column;
	// below the threshold the single-line StatusBar takes over so nothing
	// meaningful gets truncated away.
	const showLogoHeader = columns >= MIN_LOGO_HEADER_COLUMNS;
	const layout = computeChatLayout({
		rows,
		columns,
		suggestionVisible: !fileCompletion.active && isCommandSuggestionVisible(inputText),
		fileSuggestionVisible: fileCompletion.active,
		logoHeader: showLogoHeader,
	});

	// Referential stability is load-bearing: `names` is a dependency of the
	// display-lines memo in useChatScroll, so a fresh object per render would
	// rewrap the entire log on every keystroke.
	const chatNames = useMemo(
		() => ({ local: displayName, peer: selectedPeer?.displayName }),
		[displayName, selectedPeer?.displayName],
	);

	const scroll = useChatScroll({
		messages,
		localId,
		names: chatNames,
		contentWidth: layout.contentWidth,
		viewportHeight: layout.viewportHeight,
		// Scroll keys stay active whenever the ChatView is on screen —
		// including the post-disconnect case where `status` is "offline"
		// but `messages.length > 0` keeps the history visible. The
		// PeerList path still gets inactive scroll input.
		isActive: status !== "offline" || messages.length > 0,
	});

	// Copy a message's raw text to the system clipboard and surface the
	// outcome as a system entry. Fire-and-forget: copyToClipboard is
	// async (spawn round-trip), and awaiting inside a double-click handler
	// would block the next stdin chunk.
	// Transient toast state — a short-lived notice shown on the right edge of
	// the StatusBar. Copy / paste feedback and other one-shot events land here
	// rather than the message log, so the chat history stays clean.
	const [toast, setToast] = useState<StatusBarToast | null>(null);
	const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const showToast = useCallback((text: string, tone: "info" | "error" = "info") => {
		if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
		setToast({ text, tone });
		toastTimerRef.current = setTimeout(() => setToast(null), 2000);
	}, []);
	useEffect(
		() => () => {
			if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
		},
		[],
	);

	// Transfer progress goes to the toast (throttled — chunk events can
	// arrive far faster than frames), start/complete/fail go to the chat
	// log as system entries.
	const transferToastAtRef = useRef(0);
	const showTransferProgress = useCallback(
		(text: string) => {
			const now = Date.now();
			if (now - transferToastAtRef.current < 1000) return;
			transferToastAtRef.current = now;
			showToast(text);
		},
		[showToast],
	);

	const [fileReceiver] = useState(
		() =>
			new FileReceiver({
				onEvent: (event: TransferEvent) => {
					if (event.kind === "started") {
						appendSystemMessage(`Receiving ${event.fileName} (${formatBytes(event.fileSize)})…`);
						return;
					}
					if (event.kind === "progress") {
						const pct =
							event.totalBytes > 0 ? Math.round((event.receivedBytes / event.totalBytes) * 100) : 0;
						showTransferProgress(`Receiving ${event.fileName} — ${pct}%`);
						return;
					}
					if (event.kind === "completed") {
						appendSystemMessage(`Saved file: ${event.path}`);
						return;
					}
					// failed
					appendSystemMessage(
						`File transfer failed: ${event.fileName} — ${event.reason} (logs: ${getLogFilePath()})`,
					);
					// A locally-caused failure (checksum, disk, ordering) should
					// stop the sender instead of letting it stream into the void.
					// Best-effort: the connection may already be gone.
					if (!event.reason.startsWith("aborted by peer")) {
						try {
							peerConnection.send(createFileAbort(event.transferId, event.reason));
						} catch {
							// channel closed — nothing to tell the peer
						}
					}
				},
			}),
	);

	// Reconnect scheduler — declared ahead of the main `useEffect` so the
	// `onStateChange` and `onIncoming` closures registered there can call
	// into them without an "is not defined" TDZ trip. `appendSystemMessage`
	// is pulled up from below so these can reference it; that helper only
	// needs `setMessages`, which is already in scope.
	const appendSystemMessage = useCallback((text: string) => {
		const message: TextMessage = {
			type: "text",
			id: `system-${randomUUID()}`,
			timestamp: Date.now(),
			payload: { text },
		};
		setMessages((prev) => appendCapped(prev, message));
	}, []);

	const cancelReconnectTimer = useCallback(() => {
		if (reconnectTimerRef.current !== null) {
			clearTimeout(reconnectTimerRef.current);
			reconnectTimerRef.current = null;
		}
	}, []);

	const scheduleReconnect = useCallback(
		(peer: PeerInfo) => {
			if (reconnectAttemptRef.current > MAX_RECONNECT_ATTEMPTS) {
				setStatus("offline");
				appendSystemMessage(
					`Reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts. Try /reconnect or pick another peer.`,
				);
				return;
			}
			const attempt = reconnectAttemptRef.current;
			const slot = RECONNECT_BACKOFF_MS[attempt - 1] ?? RECONNECT_BACKOFF_MS.at(-1) ?? 10000;
			const seconds = Math.round(slot / 1000);
			const label =
				peer.id === "manual" ? `${peer.signalingHost}:${peer.signalingPort}` : peer.displayName;
			appendSystemMessage(
				attempt === 1
					? `Lost connection to ${label}. Reconnecting in ${seconds}s…`
					: `Reconnect attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS} in ${seconds}s…`,
			);
			reconnectTimerRef.current = setTimeout(() => {
				reconnectTimerRef.current = null;
				void attemptReconnect(peer);
			}, slot);
		},
		[appendSystemMessage],
	);

	const attemptReconnect = useCallback(
		async (peer: PeerInfo) => {
			// Release the dead session's UDP/STUN resources so the new pc's
			// ICE gather doesn't stall against the closed pc's leftovers.
			// Safe to call when no session is active.
			peerConnection.closeActiveSession();

			const myGeneration = connectionGenerationRef.current;
			try {
				await peerConnection.connect(peer.signalingHost, peer.signalingPort);
				// Success path: `onStateChange("connected")` flips status to
				// "online" and resets the attempt counter. We only run the
				// stale-generation guard here — no other state to write.
				void myGeneration;
			} catch {
				if (connectionGenerationRef.current !== myGeneration) return;
				reconnectAttemptRef.current += 1;
				scheduleReconnect(peer);
			}
		},
		[peerConnection, scheduleReconnect],
	);

	const copyAndReport = useCallback(
		(text: string) => {
			void copyToClipboard(text).then((result) => {
				if (result.ok) {
					const preview = text.length > 40 ? `${text.slice(0, 37)}...` : text;
					showToast(`Copied: ${preview.replace(/\n/g, " ")}`);
				} else {
					showToast(`Copy failed: ${result.reason}`, "error");
				}
			});
		},
		[showToast],
	);

	// Double-clicking a chat row copies that message's original text.
	// SGR row is 1-based; the first content row of the borderless chat pane
	// sits at terminal row `topMargin + topChrome + chatGutter + 1` (blank
	// top margin, Header/StatusBar, blank gutter). Converting to a global
	// display line index: subtract that header, then add firstLineIndex.
	const chatTopRow =
		CHROME_ROWS.topMargin +
		(showLogoHeader ? CHROME_ROWS.header : CHROME_ROWS.statusBar) +
		CHROME_ROWS.chatGutter;

	// Shared by the Header and StatusBar branches of the top chrome.
	const peerEndpoint = selectedPeer
		? `${selectedPeer.signalingHost}:${selectedPeer.signalingPort}`
		: undefined;
	useDoubleClick(
		useCallback(
			(_col, row) => {
				const localIdx = row - chatTopRow;
				if (localIdx < 1) return; // clicked above the first content row
				const globalIdx = scroll.firstLineIndex + (localIdx - 1);
				const messageIdx = findMessageAtLine(scroll.messageStartIndices, globalIdx);
				if (messageIdx === -1) return; // gap (e.g. unread indicator row)
				const message = messages[messageIdx];
				if (!message || message.type !== "text") return;
				copyAndReport(message.payload.text);
			},
			[scroll.firstLineIndex, scroll.messageStartIndices, messages, chatTopRow, copyAndReport],
		),
		{ isActive: status !== "offline" || messages.length > 0 },
	);

	const handleSelectBindHost = (candidate: BindCandidate) => {
		setBindHost(candidate.address);
	};

	// Startup phase: no address chosen yet, so nothing is listening and there
	// is nothing to type at. This branch must stay below every hook call —
	// React requires an unconditional hook order across renders, and the
	// transition out of this phase is a re-render of the same component.
	//
	// Rendering only the StatusBar and the picker also keeps InputBox
	// unmounted, which is what stops its Up/Down history recall from fighting
	// the picker for the same arrow keys. `useChatScroll` is already inactive
	// here (offline with an empty log), so it doesn't claim them either.
	if (bindHost === null) {
		return (
			<Box flexDirection="column" height={layout.frameHeight} paddingTop={CHROME_ROWS.topMargin}>
				<Box flexShrink={0}>
					<StatusBar
						status="offline"
						mouseEnabled={mouseEnabled}
						hint="Pick a bind address"
						toast={toast}
						version={getCurrentVersion()}
					/>
				</Box>
				<HostPicker
					candidates={candidates}
					signalingPort={signalingPort}
					onSelect={handleSelectBindHost}
					height={layout.frameHeight - CHROME_ROWS.topMargin - CHROME_ROWS.statusBar}
				/>
			</Box>
		);
	}

	return (
		// A numeric height is the only thing that pins the InputBox to the last
		// row: ink's root node never gets a height (see `ink/build/ink.js`), so
		// `height="100%"` silently resolved to `auto` and the frame grew with the
		// message log until the input scrolled off screen.
		//
		// Every direct child needs `flexShrink={0}`. Under a height-constrained
		// column, yoga shrinks Text children until their rows overlap and
		// overwrite one another — visible garbage, not clipping.
		<Box flexDirection="column" height={layout.frameHeight} paddingTop={CHROME_ROWS.topMargin}>
			<Box flexShrink={0}>
				{showLogoHeader ? (
					<Header
						status={status}
						peerName={selectedPeer?.displayName}
						peerEndpoint={peerEndpoint}
						localName={displayName}
						localEndpoint={localEndpoint ?? undefined}
						version={getCurrentVersion()}
						mouseEnabled={mouseEnabled}
						toast={toast}
					/>
				) : (
					<StatusBar
						status={status}
						peerName={selectedPeer?.displayName}
						peerEndpoint={peerEndpoint}
						mouseEnabled={mouseEnabled}
						toast={toast}
						version={getCurrentVersion()}
					/>
				)}
			</Box>
			{/* Blank gutter row between the top chrome and the message pane. */}
			<Box flexShrink={0} height={CHROME_ROWS.chatGutter}>
				<Text> </Text>
			</Box>
			{status === "offline" && messages.length === 0 ? (
				<PeerList peers={peers} onSelect={handleSelectPeer} height={layout.viewportHeight} />
			) : (
				<ChatView
					lines={scroll.visibleLines}
					firstLineIndex={scroll.firstLineIndex}
					unread={scroll.unread}
					height={layout.viewportHeight}
				/>
			)}
			<Box flexShrink={0}>
				{fileCompletion.active ? (
					<FileSuggestion
						candidates={fileCompletion.candidates}
						selectedIndex={fileCompletion.selectedIndex}
					/>
				) : (
					<CommandSuggestion partial={inputText} />
				)}
			</Box>
			<Box flexShrink={0}>
				<InputBox
					value={inputText}
					onChange={setInputText}
					onSubmit={handleSend}
					onCommand={handleCommand}
					onError={(err) => appendSystemMessage(`History unavailable: ${getErrorMessage(err)}`)}
					completion={fileCompletion}
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

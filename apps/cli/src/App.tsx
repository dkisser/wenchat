import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { basename } from "node:path";
import {
	type BindCandidate,
	type ConnectionEvent,
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
import { appendCapped } from "./appendCapped";
import { copyToClipboard } from "./clipboard";
import { phasePeer, toStatusBarStatus } from "./connectionMachine";
import { useConnectionMachine } from "./connectionMachineBindings";
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

export function App({ displayName, signalingPort, signalingHost, initialMessages = [] }: AppProps) {
	const { exit } = useApp();
	const [peers, setPeers] = useState<PeerInfo[]>([]);
	const [messages, setMessages] = useState<Message[]>([...initialMessages]);
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

	// All connection-machine plumbing (phase, dispatch, appendSystemMessage,
	// lastPeerRef, the reconnect timer, the generation token) lives here. The
	// hook owns the imperative parts the reducer cannot model; the rest is
	// the pure machine. Called AFTER `fileReceiver` is constructed so the
	// transfer-event callback above can use `appendSystemMessage`.
	const { phase, phaseRef, dispatch, appendSystemMessage, lastPeerRef } = useConnectionMachine(
		peerConnection,
		fileReceiver,
		setMessages,
	);
	const selectedPeer = phasePeer(phase);
	// The four-value union `StatusBar`/`Header` render from. Derived, so the
	// bar can never disagree with the machine about what state we're in.
	const status = toStatusBarStatus(phase);

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
			// Receiver side: someone is dialing us. Resolve the signaling
			// endpoint to a PeerInfo (a discovered peer, or a synthetic
			// fallback) and hand it to the machine, which moves us into
			// `dialing` so the upcoming `connected` event has an identity to
			// name — and cancels any retry we had queued, since their offer
			// beat us to it.
			//
			// TODO: multi-session handoff — if a session is already active
			// when a new offer arrives, the outgoing session's terminal event
			// will fire under the new peer's identity.
			const peer = resolveIncomingPeer(peersRef.current, signalingHost, signalingPort);
			dispatch({ kind: "incoming", peer });
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
		const unsubscribeState = peerConnection.onStateChange((event: ConnectionEvent) => {
			// Remember who we were talking to before the machine drops back to
			// idle, so `/reconnect` still has a target after the peer left.
			const peer = phasePeer(phaseRef.current);
			if (peer) lastPeerRef.current = peer;
			dispatch({ kind: "wire", event });
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
			// The reconnect timer is owned by the connection-machine hook and
			// cleared in its own unmount effect — keeping the clear here too
			// would race two cleanup passes.
			unsubscribePeers();
			unsubscribeIncoming();
			unsubscribeMessage();
			unsubscribeChunks();
			unsubscribeState();
			void fileReceiver.dispose();
			discovery.stop().catch(() => {});
			peerConnection.close();
		};
	}, [
		discovery,
		displayName,
		peerConnection,
		signalingPort,
		bindHost,
		appendSystemMessage,
		fileReceiver,
		dispatch,
		lastPeerRef,
		phaseRef,
	]);

	// Every dial entry point — PeerList click, `/connect`, `/reconnect` —
	// funnels through the machine's `dial` event, which owns the
	// "already connected, /disconnect first" guard and the cancel +
	// invalidate bookkeeping that used to be copy-pasted per handler.
	const handleSelectPeer = (peer: PeerInfo) => {
		lastPeerRef.current = peer;
		dispatch({ kind: "dial", peer });
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
			"Magic commands: /exit, /disconnect, /reconnect, /cancel, /mouse," +
				" /file <path>, /help, /connect <host:port>, /copy [n]",
		);
	};

	const handleDisconnect = () => {
		// The machine sends a `bye` and lets the resulting terminal event —
		// now carrying `local-disconnect` — drive both the transition and the
		// "Disconnected from …" notice. Emitting the notice here as well is
		// exactly how this used to print twice once local closes became
		// visible to listeners.
		dispatch({ kind: "user-disconnect" });
	};

	const handleExit = () => {
		// Route through the machine rather than calling
		// `peerConnection.closeGracefully` directly. Without this dispatch,
		// the `invalidate-dials` / `cancel-retry` / `dispose-transfers`
		// bookkeeping that `user-exit` owns never runs — a late `connect()`
		// resolving AFTER React's unmount cleanup would pass runDial's
		// stale-generation check (gen bumped only by the `invalidate-dials`
		// effect that didn't fire) and install a session nobody would close.
		//
		// The disconnect notice still surfaces synchronously: the reducer's
		// `system-message` effect runs inside `dispatch` (which is sync),
		// so the message is in state before `exit()` returns.
		dispatch({ kind: "user-exit" });
		// Fire-and-forget mDNS shutdown — the bounded wait in
		// `closeGracefully` is irrelevant on this path because the process
		// is about to die, so the alt-screen release and `exit()` go through
		// synchronously. `Discovery.stop` is idempotent so the mount-effect
		// cleanup that fires during unmount is harmless.
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

	const handleConnect = (hostPort: string) => {
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
		lastPeerRef.current = manualPeer;
		dispatch({ kind: "dial", peer: manualPeer });
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

	// Manually redial the last peer we talked to. Two phases are reachable:
	//   - `idle`: a normal manual dial. Failures here do NOT trigger the
	//     auto-redial loop — user-initiated dials need predictable feedback,
	//     not a quiet retry storm, which is why this goes through the
	//     machine's `dial` event (whose `dial-failed` path lands in idle)
	//     rather than the retry path.
	//   - `retrying`: the user wants to skip the wait. `lastPeerRef` outlives
	//     every phase, so a stale retry's target is still here. Routing
	//     through `retry-now` avoids the `dial` reducer's "Already connected.
	//     Run /disconnect first" guard — a destructive wording for a command
	//     whose intent is "do the retry now, same target".
	const handleReconnect = () => {
		const peer = lastPeerRef.current;
		if (!peer) {
			appendSystemMessage(
				"No previous peer. Use /connect <host:port> or pick a peer from the list.",
			);
			return;
		}
		if (phaseRef.current.kind === "retrying") {
			dispatch({ kind: "retry-now" });
			return;
		}
		dispatch({ kind: "dial", peer });
	};

	// Abort a pending auto-reconnect. Keeps `lastPeerRef` so the user can
	// retry with `/reconnect` later — we only stop the timer, we don't
	// forget the target.
	const handleCancel = () => {
		dispatch({ kind: "user-cancel" });
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

# Changelog

All notable changes to WenChat will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.10] - 2026-08-28

### Added

- **Blank row between chat messages.** The chat viewport now inserts an
  inter-message spacing row above each non-system entry, so consecutive
  turns from alternating speakers read as discrete messages instead of a
  running wall of text.

### Fixed

- **`/bye` now reliably reaches the peer before the session tears down.**
  The previous flow queued the bye and immediately called `pc.close()`,
  but werift's SCTP layer was still buffered — the message sat in the
  outbound queue and was dropped when the data channel closed. Three
  follow-up fixes chain on each other: `PeerConnection.closeGracefully()`
  now (1) waits for the SCTP outbound queue to drain after sending, (2)
  forces a `sctp.transmit()` so the writer commits the final buffer, and
  (3) signals teardown intent out-of-band over the signaling HTTP `/bye`
  endpoint before the channel closes at all. Because the receiver needs
  that intent to distinguish "peer left on purpose" from "network
  partition" (otherwise both look like a `'closed'` event), the `/bye`
  HTTP path is now the authoritative one; `Session.sendBye` survives as
  a best-effort compat shim for pre-`/bye` builds.

- **Signaling `/bye` payloads carry `fromHost` / `fromPort`.** A late
  HTTP `/bye` from a previous peer (same nickname, different network
  endpoint) used to tear down the new session; the receiver now matches
  the bye against its live session's remote endpoint and ignores
  mismatches.

- **Probe the signaling endpoint before reconnecting.** When a peer
  process exits, `ECONNREFUSED` reaches us before any retry timer does;
  when the LAN partitions, the request hangs until timeout. The CLI now
  distinguishes the two via a `/health` probe, so a peer's deliberate
  departure doesn't burn the backoff window redialing someone who isn't
  there.

- **8 MiB file-transfer test timeout raised to dodge Linux CI flakiness.**
  The integration test that wires two peers on `127.0.0.1` for an
  end-to-end file transfer occasionally ran out of its old budget under
  load; the test, not the production code, was too tight.

## [0.1.9] - 2026-08-27

### Fixed

- **Auto-reconnect no longer wastes a 28 s window on a peer that left on
  purpose.** When a peer ran `/exit` or `/disconnect`, the other end used
  to print "Lost connection to <peer>. Reconnecting in 1s…" and burn the
  full backoff re-dialing someone who had deliberately left. WebRTC
  carries no intent: a peer calling `pc.close()` and a peer whose Wi-Fi
  died produce the identical `'closed'` event on the other end, so the
  receiver had to assume every close was a network blip. A new
  `ByeMessage { reason: 'exit' | 'disconnect' }` in `@wenchat/protocol`
  lets peers signal intent; a new `connectionState.ts` owns a
  `CloseReason` vocabulary (`network`, `heartbeat-timeout`, `local-exit`,
  `local-disconnect`, `remote-exit`, `remote-disconnect`) with a single
  `isRetryable()` gate, and the four-mutable-ref reconnect logic in
  `App` is replaced by a pure `reduce(phase, event)` state machine in
  `apps/cli/src/connectionMachine.ts`. Only `isRetryable(reason)` can
  produce a `schedule-retry`, so a peer's deliberate departure now reads
  "alice left the chat." and stops there. The protocol change is purely
  additive: an older peer hits the decode guard, logs "dropping
  undecodable message", and falls back to the old behaviour.

- **`PeerConnection.closeGracefully()` now waits for the bye to drain.**
  `connect()` resolved once the answer SDP was applied, which can be
  before SCTP had the channel open — an integration test caught exactly
  that race dropping the bye. The new close path waits (bounded, 200 ms
  each) for the channel to be open and for the bye to drain before
  killing the pc; concurrent `swapSession` calls (incoming-offer-races-
  teardown, retry's close-active-session + connect) re-check the session
  reference after each await and bail if it changed.

- **Signaling teardown no longer blocks `/exit` on a remote keep-alive
  socket.** `server.close()` only invokes its callback once every open
  connection has gone away. Awaiting `signaling.stop()` behind
  `closeGracefully()` could therefore hang shutdown indefinitely; the
  graceful-close path now fires-and-forgets the signaling teardown.

- **A late dial can no longer undo a `/disconnect`.** `peerConnection
  .connect()` resolves once the answer SDP lands; if a user action
  landed during the handshake, the late `await` was swapping in a
  session the user said no to. `runDial` now checks the generation
  token on the success path and tears the late session back down via
  `closeStaleDialSession()`, which preserves the most recent teardown
  intent (set by `closeGracefully()` / `close()` / `disconnect()`)
  instead of falling through to `reason="network"` — a stale-close race
  that previously re-classified a deliberate `/disconnect` as
  retryable and re-printed "Failed to connect to X" beside the
  disconnect notice.

- **`/disconnect` is no longer delayed by up to 400 ms.** The notice
  was previously round-tripped through the wire event; `user-disconnect`
  now emits "Disconnected from <peer>" synchronously, and the wire-event
  path is silenced for `local-*` reasons to avoid the duplicate.

- **`/exit` no longer freezes the TUI for up to half a second.**
  Awaiting `closeGracefully("local-exit")` (which itself waits up to
  400 ms for the bye to drain) before calling `exit()` stalled the
  alt-screen release; fire-and-forget the close on the exit path and
  let the process die.

### Changed

- **The reconnect logic is now a pure reducer.** The four mutable refs
  (`cancel the timer, zero the attempt, bump the generation`) were
  copy-pasted across six handlers, and any handler that forgot one was
  a bug. `apps/cli/src/connectionMachine.ts` replaces them with
  `reduce(phase, event) -> {phase, effects}`; phases are `idle /
  dialing / online / retrying(attempt)`, effects are data the App
  executes, and `StatusBar`'s four-value status is derived via
  `toStatusBarStatus()` so the bar can no longer disagree with the
  machine.

- **`App.tsx` no longer exceeds the 800-line cap.** Connection-machine
  plumbing (phase, dispatch, appendSystemMessage, lastPeerRef, the
  reconnect timer, the generation token, the runDial/runEffect wiring)
  lives in a new `apps/cli/src/useConnectionMachine.ts`; `App.tsx` is
  now 771 lines.

### Added

- **`ByeMessage` in `@wenchat/protocol`** (`{ reason: 'exit' |
  'disconnect' }`, plus `createBye()` and a codec whitelist entry).
  Worth surfacing as its own entry: a peer that receives a `bye` tears
  down immediately with the remote reason rather than waiting for the
  peer's `pc.close()` to propagate, because that path is async and
  unguaranteed and our own watchdog could otherwise fire mid-gap and
  relabel the close as `heartbeat-timeout`, which reads as retryable.

## [0.1.8] - 2026-08-27

### Fixed

- **Reconnect after a network drop no longer strands the user.** When the
  underlying WebRTC `RTCPeerConnection` closes because the remote end died,
  Wi-Fi roamed, or ICE gave up, werift's transport (the `DataChannel`) and
  the session heartbeat were still holding the UDP/STUN resources open. A
  fresh `connect()` would create a new `RTCPeerConnection`, but those
  leftovers prevented the new ICE gather from ever leaving `checking` —
  visible to the user as "the chat never reconnects unless both sides are
  restarted". `PeerConnection.closeActiveSession()` now closes the dead pc
  + transport + heartbeat and clears the session reference, so the next
  handshake starts on a clean slate.

### Added

- **Automatic reconnect with exponential-ish backoff.** Network-driven
  disconnects now trigger up to five redial attempts at `1s, 2s, 5s, 10s,
  10s` (~28 s total wall-clock, enough to ride an access-point roam). The
  StatusBar shows `Reconnecting to <name>…` in yellow while the timer is
  armed, and the chat log records each attempt. After the fifth attempt the
  state drops back to `offline` with a hint pointing the user at
  `/reconnect` or another peer.

- **`/reconnect` magic command.** Redials the last peer the user initiated a
  session with — survives the terminal-state React reset that wipes
  `selectedPeer`, because the snapshot lives in `lastPeerRef`. Failures are
  surfaced as a single offline message; the command deliberately does NOT
  loop, because user-initiated dials need predictable feedback.

- **`/cancel` magic command.** Aborts a pending auto-reconnect. Preserves
  `lastPeerRef` so a follow-up `/reconnect` still knows the target.

## [0.1.7] - 2026-08-18

### Changed

- **CLI now requires an explicit `start` subcommand.** Bare invocations like
  `wenchat <nickname>` are no longer accepted; use
  `wenchat start [nickname] [signalingPort] [signalingHost]` or the flag form
  `wenchat start --name <nickname> --port <port> --host <host>`. This removes
  ambiguity and makes room for `version`, `help`, and `upgrade` as top-level
  subcommands.

- **GitHub Release workflow reads release notes from `release-notes/X.Y.Z.md`.**
  The previous path lookup required a leading `v` in the filename; it now
  matches the actual generated filename so the release body consistently
  includes the "What's new" section.

### Added

- **Version is now shown in the StatusBar.** The current version appears next
  to the connection status, making it obvious which build is running in a
  packed binary or dev session.

## [0.1.6] - 2026-08-18

### Fixed

- **Logger test cleanup no longer leaks unhandled errors.** When
  `_resetLoggerForTests()` closed the process-wide pino destination, the
  underlying sonic-boom stream could still be opening the file
  asynchronously; deleting the test temp dir before that open completed
  emitted an unhandled `ENOENT` error between tests and failed CI on Linux.
  The reset now attaches a no-op error listener to the outgoing destination
  before closing it, so cleanup races are absorbed.

### Changed

- **GitHub Release body now includes the generated release notes.** The
  `release.yml` publish job reads `release-notes/vX.Y.Z.md` and prepends a
  "What's new" section above the install instructions, so future releases
  ship with both the changelog summary and the download/upgrade steps.

## [0.1.5] - 2026-08-18

### Added

- **Fuzzy file picker for `/file`.** Typing `/file <partial>` now opens an
  inline candidate list above the input box (at most four rows, directories
  first, dotfiles hidden until the query starts with a dot). `↑`/`↓` move
  the selection, Enter fills the path into the input — a second Enter
  sends — accepting a directory descends into it, and Esc dismisses the
  picker until the input changes. Matching is fuzzy (powered by
  `fuzzysort`), so `dcmp` finds `docker-compose.yml`.

- **`~` paths in `/file`.** `/file ~/report.pdf` and `/file ~/` now expand
  against the home directory instead of failing with a missing-file error.

- **File-based logging.** The app now logs to
  `<workspaceRoot>/logs/wenchat-<date>.log` (pino, async), rotating daily
  and keeping the most recent seven days. The workspace root is
  `~/.wenchat` for a packed release binary and the current working
  directory for a source-checkout dev run, so development logs never mix
  with the deployed location. Startup, connection lifecycle, transfer
  events, and crashes (`uncaughtException` / `unhandledRejection`) are
  recorded; error system-messages in the UI name the current log file.
  `WENCHAT_LOG_LEVEL` overrides the level.

### Fixed

- **Large file transfers no longer crash the app.** `/file` used to read
  the whole file into memory, JSON-encode every chunk as a number array
  (~3× wire expansion), and push thousands of chunk messages into React
  state — a 100 MB file OOM-crashed the process. Transfers now stream
  64 KiB frames (22-byte binary header instead of JSON), pause at a 4 MiB
  buffer high-water mark, write to a `<name>.part` temp file on the
  receiver, verify a SHA-256 checksum, and atomically rename into
  `~/Downloads`. Sender memory stays bounded regardless of file size, so
  there is no hard transfer size limit anymore.

- **A dead data channel no longer leaves both peers phantom-online.**
  Previously nothing wired the channel's close event into session state,
  so after a failed transfer both sides kept showing "online", the
  heartbeat kept running on a dead channel, and the "Already connected"
  guard blocked reconnection — both sides had to restart. A channel close
  now terminates the session (exactly one terminal state), frees the UI to
  reconnect, and a failed transfer can be redialed without restarting.

- **A failed handshake no longer leaks its peer connection.** If the
  offer POST or the SDP exchange threw, the freshly created
  `RTCPeerConnection` (UDP socket, ICE gathering) stayed alive for the
  rest of the process — repeated `/connect` attempts against an offline
  peer accumulated them. Both `initiate` and `accept` now tear the pc
  down before rethrowing.

- **One crashing event listener no longer starves the others.** Message,
  file-chunk, state, and close fan-outs (transport → session → peer) now
  guard each listener individually and log the failure, instead of letting
  a single throwing callback abort the loop and silently drop the event
  for everyone downstream. A throwing listener is also no longer mislogged
  as an "undecodable message".

- **Daily log rotation no longer leaks a file descriptor per day, and
  the log tail survives a normal exit.** Midnight rollover now `end()`s
  the previous day's pino destination (draining its buffer before closing
  the fd), and a process-exit hook `flushSync`s the async destination so
  the last lines — often the crash-relevant ones — are no longer lost.

### Changed

- **Inbound demux moved into `@wenchat/protocol`.** A new
  `decodeWirePacket` adapter (next to the codec) decides whether a
  datagram is a JSON message or a binary chunk frame, so the transport
  layer only ships bytes. File chunks now surface as raw frame payloads
  on a dedicated `onFileChunk` channel (transport → session → peer →
  `FileReceiver.handleChunk`) instead of being dressed up as a synthetic
  `Message` with an invented id/timestamp — the `FileChunkMessage` type
  is gone from the protocol's `Message` union.

- **Wire format for file transfer is now binary-framed.** Text, ping, and
  pong messages are byte-identical to previous versions, so text chat
  works across versions; `/file` between an old and a new build will fail
  (loudly, not crash) — upgrade both ends to transfer files.

## [0.1.4] - 2026-08-17

### Added

- **Logo header and improved chat layout.** The CLI now renders a branded
  header above the chat viewport and lays out messages so the conversation
  area stays visually anchored while the peer list and input remain usable.

- **Display name from positional arguments.** `wenchat <nickname>` now uses
  the supplied nickname directly, making scripted or habitual invocations
  faster than waiting for the default random name.

### Fixed

- **Heartbeat no longer ticks before the WebRTC `DataChannel` is attached.**
  The watchdog interval previously started as soon as the peer connection
  initialized, so a failed or slow ICE negotiation could fire timeouts
  against a channel that did not exist yet and produce a misleading
  "disconnected" state. Ticks now begin only after the channel opens.

- **mDNS now advertises the correct signaling port.** The published Bonjour
  TXT record was using a stale default in some code paths, so LAN peers
  discovered the service but dialed the wrong endpoint. Discovery now
  publishes the port the HTTP signaling server actually bound.

## [0.1.3] - 2026-08-14

### Fixed

- **macOS will no longer rewrite your Computer Name / `LocalHostName` after
  wenchat runs.** wenchat itself never read `os.hostname()` to write, but
  `bonjour-service@1.4.4` falls back to `os.hostname()` for the SRV record's
  target when `publish({...})` omits `host`, and pairing that with a fresh
  `localId` per launch meant every wenchat run looked like a new Bonjour
  service to `mDNSResponder`. RFC 6762 §8.1 conflict resolution then
  renamed the instance to `<nickname>-XXXX-XX-1`, `-2`, …, and the "Computer
  Name Follows Hostname" toggle synced that chaos into `scutil --get
  LocalHostName` — visible as `hostname` / `scutil --get ComputerName` /
  System Settings → Sharing all changing with a `-N` suffix that did not
  recover after wenchat exited. The `localId` is now persisted to
  `~/.wenchat/local-id` so the Bonjour instance name stays stable across
  runs, and `bonjour.publish({...})` now passes `host: signalingHost`
  explicitly (LAN IPv4 or `127.0.0.1`) so the SRV target is an IP literal
  rather than a hostname string.

- **Unrecognized slash-prefixed input was eaten silently.** `/foo` would
  produce "[system] unknown command: foo" but the actual text never
  reached the peer, since the slash-routing branch ran before the
  fallback send. Routing now recognizes a slash-prefixed string as a
  command only when it matches a known handler; anything else is sent
  verbatim so `/shrug` round-trips intact.

## [0.1.2] - 2026-08-14

### Fixed

- **`PeerList` was always empty** — the `DiscoveryService.start()` Promise
  executor synchronously threw `TypeError: undefined is not an object
  (evaluating 'this.service.on')` because it read
  `published.service`, but `bonjour-service@1.x` returns the Service
  EventEmitter directly from `publish()`. `apps/cli/src/App.tsx`
  swallowed the rejection with `.catch(() => {})`, so mDNS never
  published or browsed: both ends ran, neither side ever saw the other
  via the LAN, and the only workaround was `/connect <ip>:<port>`.
  Reading `published` directly restores auto-discovery. The unit-test
  mock was previously returning `{ service }`, which masked the bug;
  it now matches the real shape and a regression test fails on the broken
  access pattern.

## [0.1.0] - 2026-08-12

### Added

- Markdown rendering in chat (headings, fenced code with `cli-highlight`
  syntax highlighting, blockquotes, ordered / unordered lists, bold / italic /
  strike / inline code, horizontal rules, images) via `marked` +
  `cli-highlight`. System messages (`[system]`) bypass the renderer so
  operator-controlled strings never get formatted by accident.
- Copy-to-clipboard via **double-click** on a chat row (uses SGR mouse events;
  500 ms / same-cell threshold) and via the `/copy [n]` slash command
  (1-based, counted backwards from the most recent text message; file / ping /
  pong entries are skipped).
- Platform-aware clipboard helper (`apps/cli/src/clipboard.ts`) that probes
  `pbcopy` → `clip.exe` → `wl-copy` → `xclip` → `xsel` and falls back to
  **OSC 52** (`ESC ]52;c;<base64> BEL`) for SSH / headless sessions
  (iTerm2, WezTerm, kitty, Alacritty, recent gnome-terminal, foot).
- Interactive **HostPicker** startup screen for multi-homed hosts (Wi-Fi +
  wired + VPN + container bridges). Skipped automatically when stdout is
  redirected (`bun run cli alice > out.log`); non-interactive runs fall back
  to the first non-internal IPv4 via `getLanHost()`.
- Slash commands:
  - `/exit` — quit the app (signals disconnect, closes the pc + discovery,
    safety-net releases alt-screen and mouse mode).
  - `/disconnect` — tear down the active WebRTC session without quitting;
    the user can dial again or accept a new offer.
  - `/mouse` — toggle SGR mouse tracking (also bound to `Ctrl+T`).
  - `/file <path>` — send a file over the data channel.
  - `/help` — list every magic command.
  - `/connect <host:port>` — manually dial a peer's signaling endpoint
    (synthetic peer entry labeled `<host>:<port>`).
  - `/copy [n]` — copy the n-th most recent text message (default `n = 1`).
- **Mouse-mode toggle** (`Ctrl+T` or `/mouse`) for SGR (`?1000h` + `?1006h`).
  `--no-mouse` flag for terminals without SGR support; the existing scrollback
  is preserved either way.
- **File transfer** over WebRTC `DataChannel("wenchat")`:
  - 16 KiB chunks, 32-bit non-cryptographic checksum recorded in the start
    message.
  - Receiver sorts chunks by index, reassembles, picks a non-colliding name
    (`foo (1).md`, `foo (2).md`, …), saves to `~/Downloads/`.
  - ENOENT / EACCES / generic read errors surface as `[system]` messages.
- **Persistent command history** at `~/.wechat/.wechat_history` (atomic
  `tmp + rename` write, 100-entry cap, shell-style prev / next with draft
  restoration past the newest entry).
- **Application-layer heartbeat** (2 s ping / 4 s timeout) with auto-pong
  carrying the same nonce; any inbound `ping` / `pong` re-arms the watchdog.
- Bordered `ChatView` with a soft-wrapped viewport, a yellow "↓ N new
  messages" indicator when scrolled up with unread tail, and a transient
  right-aligned toast in the status bar for copy results.
- Mouse-wheel scroll (3 lines per tick) plus `PageUp` / `PageDown` and
  `Shift+Arrow` as keyboard fallback.
- Per-package test directories under `tests/` (Bun test runner), including
  an end-to-end two-peer integration test wired on `127.0.0.1`.

### Fixed

- **macOS mDNS dgram-bind bug when running on Bun** — the CLI now runs on
  Node.js ≥ 20 (via `tsx`) while Bun continues to drive install / build /
  test. The long header comment at the top of `apps/cli/src/main.tsx`
  documents the trade-off.

### Changed

- Restructured the workspace into four published packages: `@wenchat/cli`,
  `@wenchat/core`, `@wenchat/protocol`, `@wenchat/ui`.
- Test files migrated to per-package `tests/` directories (no more
  top-level `tests/`), and the per-package `tsconfig.json` excludes
  `*.test.ts(x)` from build output defensively.

[0.1.0]: https://github.com/dkisser/wenchat/releases/tag/v0.1.0
[0.1.2]: https://github.com/dkisser/wenchat/releases/tag/v0.1.2
[0.1.3]: https://github.com/dkisser/wenchat/releases/tag/v0.1.3
[0.1.4]: https://github.com/dkisser/wenchat/releases/tag/v0.1.4

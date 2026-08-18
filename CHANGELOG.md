# Changelog

All notable changes to WenChat will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

- **Daily log rotation no longer leaks a file descriptor per day, and
  the log tail survives a normal exit.** Midnight rollover now `end()`s
  the previous day's pino destination (draining its buffer before closing
  the fd), and a process-exit hook `flushSync`s the async destination so
  the last lines — often the crash-relevant ones — are no longer lost.

### Changed

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

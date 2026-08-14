# Changelog

All notable changes to WenChat will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/).

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

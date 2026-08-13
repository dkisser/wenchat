# WenChat

[中文](./README.zh-CN.md) · [Changelog](./CHANGELOG.md) · [License](./LICENSE)

> **LAN-only P2P terminal chat: mDNS auto-discovery + direct WebRTC. No server, no STUN/TURN, no cloud relay.**

[![license](https://img.shields.io/github/license/dkisser/wenchat?style=flat-square)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![bun](https://img.shields.io/badge/bun-%E2%89%A51.1-f9f1e1?style=flat-square&logo=bun&logoColor=black)](https://bun.sh)
![typescript](https://img.shields.io/badge/typescript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)
![tui](https://img.shields.io/badge/tui-ink-61dafb?style=flat-square&logo=react&logoColor=white)
![transport](https://img.shields.io/badge/transport-webrtc_--_data_channel-333333?style=flat-square)
![discovery](https://img.shields.io/badge/discovery-mdns_--_bonjour-0078d4?style=flat-square)

Open two terminals on the same Wi-Fi, wired, or VPN network and start
chatting with a single command — no public internet, no accounts, no
messages leaving your LAN. Text supports Markdown rendering, you can
transfer files, double-click to copy, and press `Ctrl+T` to toggle the
native mouse-selection mode.

## Table of Contents

- [Features](#features)
- [Preview](#preview)
- [Installation](#installation)
- [Quick Start](#quick-start-local-development)
- [Slash Commands](#slash-commands)
- [Tech Stack](#tech-stack)
- [Project Layout](#project-layout)
- [Configuration](#configuration)
- [Development](#development)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## Features

**Networking**

- 🔍 **mDNS / Bonjour auto-discovery** — peers on the same LAN appear
  instantly, no IP typing required
- 🔗 **WebRTC `DataChannel` direct** — pure P2P, no STUN / TURN, no
  relay server
- 🛡️ **DTLS in-transit** — link-layer encryption; the data channel
  itself carries plaintext frames
- 💓 **Application-layer heartbeat** — 2 s ping / 4 s timeout with
  auto-pong and automatic cleanup on link loss

**Chat UX**

- ✍️ **Markdown rendering** — headings, lists, blockquotes, fenced code
  blocks (with `cli-highlight` syntax highlighting), bold / italic /
  strikethrough / inline code / links / horizontal rules / images
- 📋 **Double-click to copy** — point at a chat row and double-click
  to copy its original text; a 2 s toast in the status bar confirms
- 📑 **`/copy [n]` command** — copy the n-th most recent text message
  (1-based; file / ping / pong entries are skipped)
- ⌨️ **`/mouse` command** (or `Ctrl+T`) — toggle SGR mouse tracking
  (`?1000h` + `?1006h`); modes auto-release on exit
- 🧭 **`Tab` completion** — type `/fi` → `/file`, press `Tab` again
  for a trailing space

**File transfer**

- 📎 **`/file <path>`** — send any local file over the data channel
- 🧩 **Chunked** — 16 KiB / chunk with a 32-bit checksum recorded in
  the start message
- 🗂️ **Collision-safe save** — defaults to `~/Downloads/` with
  `foo (1).md`, `foo (2).md` … to dodge existing names

**Network resilience**

- 🌐 **Startup bind-address picker** — multi-homed hosts (Wi-Fi +
  wired + VPN + container bridges) get an interactive LAN / loopback /
  `0.0.0.0` picker at startup
- 🚇 **Non-TTY auto-degrade** — when stdout is redirected (`> out.log`,
  CI, SSH without a TTY) the picker is skipped and the detected LAN
  IPv4 is used silently
- 🎯 **`/connect <host:port>`** — manually dial any signaling endpoint
  as a fallback when mDNS can't see the peer

**Terminal engineering**

- 🖼️ **VT100 alternate-screen buffer** — clean background on entry;
  original shell history restored on exit (`/exit` or `Ctrl+C`), no
  residue
- 🪟 **SIGWINCH-aware** — re-lays out on terminal resize
- 💾 **Persistent command history** — `~/.wechat/.wechat_history`,
  atomic write, 100-entry cap
- 🚦 **Stability guard** — selecting a peer while connected shows
  "Already connected. Run `/disconnect` first to switch peer."

## Preview

```
┌─ Status ──────────────────────────────────┐
│ Online • alice (192.168.1.42:9001)        │
└───────────────────────────────────────────┘

┌─ Peers ──────────────┐  ┌─ Chat ────────────────────────────────────┐
│ > alice (you)         │  │ [11:23] [peer] This is a **Markdown** test │
│   bob (192.168.1.50)  │  │             *italic*  `inline code`        │
│   carol               │  │             > blockquote                  │
│                       │  │             1. ordered list               │
│                       │  │             2. item two                   │
│                       │  │             ```ts                        │
│                       │  │             const x: number = 42;        │
│                       │  │             ```                         │
│                       │  │ [11:24] [system] File received: foo.md  │
└───────────────────────┘  └──────────────────────────────────────────┘

> /help
```

## Installation

End users do not need Node.js, Bun, or any other runtime — wenchat
ships as a single self-contained binary that embeds Node and all
dependencies. No `npm install` step is required.

### One-line install (Linux / macOS)

```sh
curl -fsSL https://raw.githubusercontent.com/dkisser/wenchat/main/scripts/install.sh | bash
```

The script auto-detects your platform (Linux x86_64 or Apple Silicon),
downloads the matching binary, and installs it to
`$HOME/.local/bin/wenchat` (no `sudo` required). If that directory is
not on your `$PATH` already, the installer prints the line you need
to add to your shell rc.

### One-line install (Windows / PowerShell)

```powershell
iwr -useb https://raw.githubusercontent.com/dkisser/wenchat/main/scripts/install.ps1 | iex
```

Installs to `%USERPROFILE%\bin\wenchat.exe` and appends that directory
to your user `PATH`. Restart PowerShell afterwards.

### Direct download

Pick the binary that matches your platform from the
[latest release](https://github.com/dkisser/wenchat/releases/latest).
File names follow the pattern `wenchat-v<version>-<platform>[.exe]`
— for example `wenchat-v0.1.0-linux-x64`.

| Platform | Architecture |
| --- | --- |
| Linux | x86_64 |
| macOS | Apple Silicon (arm64) |
| Windows | x64 |

Then on Linux / macOS: `chmod +x wenchat-*` and move it somewhere on
your `$PATH`. On Windows: just run it from wherever you saved it
(or move it onto your `PATH`).

### Upgrade an existing install

```sh
wenchat upgrade              # download the latest release and replace
wenchat upgrade --check-only # check only; print the newer version
```

The `upgrade` subcommand queries the GitHub API for the latest
release, detects your platform, downloads the matching asset, and
atomically replaces the running binary. **Windows is the exception**
— the new file is staged next to the old one (a running `.exe`
cannot be replaced) and the installer prints a one-line instruction
to swap them manually.

### First-run note (macOS / Windows)

Unsigned binaries trigger a one-time system prompt:

- **macOS Gatekeeper**: in Finder, right-click the binary → Open →
  confirm. Subsequent runs are silent.
- **Windows SmartScreen**: click "More info" → "Run anyway".
  Subsequent runs are silent.

This is the same pattern used by `deno`, `bun`, `hugo`, and `rustup`.
WenChat does not ship with an Apple Developer ID or code-signing
certificate because it is a CLI tool, not a graphical app.

## Quick Start (local development)

> End users should follow [Installation](#installation) above. This
> section is for contributors and people hacking on wenchat itself.

### Prerequisites

- **Node.js ≥ 20** (macOS / Linux / Windows; **do not run the CLI on
  Bun** — see note below)
- **Bun ≥ 1.1** (drives install / build / test)

### Install

```bash
bun install
```

### Run

In terminal A:

```bash
bun run cli alice
```

In terminal B:

```bash
bun run cli bob
```

The peer appears in the list immediately — `↑/↓ + Enter` to connect
and start chatting.

> The first positional argument (`alice` / `bob`) is WenChat's mDNS
> service instance name — it does **not** modify your system's
> hostname. If macOS shows a "name changed" alert in System Settings,
> that's `mDNSResponder` reflecting the Bonjour service name back into
> Sharing, and is unrelated to WenChat's code.

### Picking a bind address

On multi-homed hosts (Wi-Fi + wired + VPN + container bridges) the
startup screen lists every bindable address:

```
┌────────────────────────────────────────────────────────────┐
│ Select bind address (port: auto)                           │
│ > 192.168.1.42 (en0)                                       │
│   127.0.0.1 (lo0)  local only — LAN peers cannot reach you │
│   0.0.0.0  all interfaces                                  │
│ ↑↓ navigate · Enter to confirm                             │
└────────────────────────────────────────────────────────────┘
```

You can also skip the picker by passing the address directly:

```bash
bun run cli alice 9001 192.168.1.42
```

When stdout is redirected (`bun run cli alice > out.log`) the picker
is suppressed and the detected LAN IPv4 is used automatically.

## Slash Commands

Type a line beginning with `/`. `Tab` completes command names.

| Command | Description |
| --- | --- |
| `/exit` | Quit WenChat (closes the pc, stops mDNS, releases alt-screen and mouse mode) |
| `/disconnect` | Tear down the active WebRTC session without quitting |
| `/mouse` | Toggle SGR mouse tracking (alias for `Ctrl+T`) |
| `/file <path>` | Send a local file over the data channel |
| `/help` | List every command |
| `/connect <host:port>` | Manually dial any signaling endpoint |
| `/copy [n]` | Copy the n-th most recent text message (default `n=1`) |

Input ergonomics:

- `↑` / `Ctrl+P` recall previous history; `↓` / `Ctrl+N` go forward;
  past the newest entry the original draft is restored
- `Tab` completes a command name; a second `Tab` adds a trailing
  space to invite the argument
- SGR mouse reports are stripped from typed input so wheel ticks
  can't leak into the prompt

## Tech Stack

| Role | Technology |
| --- | --- |
| Package manager / build / test | Bun (workspace + test runner) |
| CLI runtime | Node.js ≥ 20 (via `tsx` to execute `.ts` / `.tsx`) |
| Terminal UI | [Ink](https://github.com/vadimdemedes/ink) + React 18 |
| Rendering pipeline | `marked` (GFM disabled) → `cli-highlight` → SGR string → `wrap-ansi` |
| Transport | [`werift`](https://github.com/shinyoshiaki/werift) (pure-JS WebRTC + DataChannel) |
| Auto-discovery | [`bonjour-service`](https://github.com/onuteam/bonjour-service) (mDNS) |
| Signaling | In-process `http.createServer` exposing only `POST /offer` and `POST /candidate` |
| Code style | TypeScript strict + Biome |

### Why does the CLI run on Node and not Bun?

`multicast-dns` has a known bug on Bun where a failed `dgram.bind()`
on macOS bypasses `uncaughtException` and terminates the process
outright (see commit `d02de50`). The CLI therefore runs on Node;
Bun continues to drive install / build / test, sidestepping the
runtime compatibility pitfall.

## Project Layout

```
wenchat/
├── apps/
│   └── cli/                 @wenchat/cli  — Ink TUI entry point
├── packages/
│   ├── protocol/            @wenchat/protocol — shared message / chunk types and serialization
│   ├── core/                @wenchat/core — WebRTC / mDNS / signaling / heartbeat
│   └── ui/                  @wenchat/ui — reusable Ink components
├── docs/                    Internal design docs
├── scripts/                 smoke-lan-bind.ts and other dev-time scripts
├── biome.json               Lint / format config
└── bunfig.toml              Bun config
```

## Configuration

The CLI is configured purely through positional arguments — **no
environment variables are read**.

```bash
bun run cli <nickname> [signalingPort] [signalingHost]
```

| Argument | Description | Default |
| --- | --- | --- |
| `nickname` | Display name carried in the mDNS TXT record (does not modify your system hostname) | `user-<random>` |
| `signalingPort` | Signaling HTTP port (`0` = OS-assigned) | `0` |
| `signalingHost` | Explicit bind address (omit on an interactive run to open the picker) | — |

Optional flag:

- `--no-mouse` — disable SGR mouse tracking (for terminals that don't
  support SGR)

Clipboard resolution: native helper first (`pbcopy` / `clip.exe` /
`wl-copy` / `xclip` / `xsel`), then OSC 52 written directly to
stdout. iTerm2 requires Preferences → Advanced → "Allow clipboard
read/write from shell" for OSC 52 to take effect.

## Development

```bash
# All unit + integration tests (Bun test runner)
bun test

# Tests for a single package
bun --filter '@wenchat/core' test

# Type-check + emit
bun run build

# Lint / format
bun run lint
bun run format

# Signaling-bind regression check
bun scripts/smoke-lan-bind.ts
```

Integration tests wire two `PeerConnection`s on `127.0.0.1` with
`setInterval` polls; the slow ~5 s timeouts are intentional.

## Contributing

Commits follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat(scope): …` / `fix(scope): …` / `chore: …`). Before opening a
PR please:

1. `bun test` is green
2. `bun run lint` passes
3. For any signaling / bind change, run `bun scripts/smoke-lan-bind.ts`

Bugs and feature requests go to
[Issues](https://github.com/dkisser/wenchat/issues).

## Security

Please read [SECURITY.md](./SECURITY.md). **Do not** file public
issues for security-sensitive reports — use GitHub Security
Advisories or the private email listed there.

## License

[MIT](./LICENSE) © 2026 dkisser

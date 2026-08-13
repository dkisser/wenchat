# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

WenChat is a LAN-only, peer-to-peer terminal chat tool: peers auto-discover via mDNS (Bonjour), exchange SDP/ICE through an in-process HTTP signaling server, then chat and transfer files over WebRTC `DataChannel`, rendered in an Ink (React-based) TUI.

## Monorepo layout

Bun workspaces (`workspaces: ["apps/*", "packages/*"]`); inter-package refs use `"workspace:*"`. No pnpm/yarn/turbo/nx/lerna.

- `apps/cli` — `@wenchat/cli` — Ink TUI entry point
- `packages/core` — `@wenchat/core` — WebRTC, mDNS, signaling, peer transport
- `packages/protocol` — `@wenchat/protocol` — pure types for messages/chunks, no runtime deps
- `packages/ui` — `@wenchat/ui` — Ink components + helpers

Package-specific gotchas load on demand when editing those paths:
- `.claude/rules/cli.md` — for `apps/cli/**`
- `.claude/rules/core.md` — for `packages/core/**`

## Canonical commands

- `bun install` — install (pinned exact versions per `bunfig.toml`; lockfile is `bun.lockb`; never introduce npm/yarn/pnpm lockfiles)
- `bun run cli <nickname> [signalingPort] [signalingHost]` — run the terminal app
- `bun test` — run all tests (Bun test runner; imports `from "bun:test"`)
- `bun run build` — `bun run --filter '*' build` (per-package `tsc -p tsconfig.json`, output to `dist/`)
- `bun run lint` — `biome check .`
- `bun run format` — `biome format --write .`
- `bun scripts/smoke-lan-bind.ts` — LAN-bind regression check; run after any `signaling.ts` bind change

There is no `bun run check`; `biome` only lints, it does not typecheck.

## Runtimes

- **CLI runs on Node.js (≥ 20), not Bun** — Bun has an mDNS bind bug on macOS (commit `d02de50`). Do not switch the CLI runtime back to Bun.
- **Bun drives install / build / test.** Bun version is not pinned.
- `process.env` is not used anywhere; configuration is via CLI positional args.

## Code style

- **Tabs for indent, 100-char line width** (Biome config)
- **`type`, not `interface`; no `enum`** — use literal-string discriminants for unions
- **Named exports only**, no default exports
- **Type-only imports** for types
- Strict TS is on: `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`
- Per-package `tsconfig.json` excludes `src/**/*.test.ts(x)` from build output (no-op after the per-package `tests/` migration, kept defensively)
- Logger: `pino` (used in `@wenchat/core` and `@wenchat/cli`); avoid `console.log` in app/package source

## Testing

- Bun's built-in test runner; tests live under each package's `tests/` directory, mirroring the source tree: `apps/cli/tests/` (no subdirs), `packages/core/tests/{unit,integration}/`, `packages/protocol/tests/`, `packages/ui/tests/{components,helpers}/`. Filename is `*.test.ts` / `*.test.tsx`. Tests reference production code via relative path (e.g. `../../src/peer`) or the existing workspace aliases (`@wenchat/protocol`).
- React/Ink components use `ink-testing-library`
- Integration tests wire two `PeerConnection`s on 127.0.0.1 with `setInterval` polls — slow by design (~5s timeouts)

## Message rendering & clipboard

- Inbound text messages are run through `renderMarkdown` (`packages/ui/src/markdown.ts`) before `wrap-ansi` — this preserves original newlines, indentation, and consecutive spaces, and adds CommonMark styling (bold / italic / inline / fenced code with `cli-highlight` highlighting, blockquotes, lists, hr). System entries (`[system]`) bypass the renderer so operator strings never become formatted by accident.
- `toDisplayLines` returns `{ lines, messageStartIndices }`; the start-index array lets a click coordinate map back to the message owning that line (`findMessageAtLine`).
- ChatView uses `wrap="wrap"` (matching `wrap-ansi` `{trim:false, hard:true}`) so the "flat line count = rendered row count" invariant survives markdown.
- Copy-to-clipboard is exposed two ways: **double-click** a message row (uses `useDoubleClick`, SGR mouse events; only left-button presses within 500 ms at the same coord count) and ** `/copy [n]` ** (1-based nth from most recent; file/ping/pong messages do not count).
- `apps/cli/src/clipboard.ts` probes the platform helper in order (`pbcopy` on macOS, `clip.exe` on Windows, `wl-copy` / `xclip` / `xsel` on Linux). When none is available, falls back to **OSC 52** (`\x1b]52;c;<base64>\x07`) written via `process.stdout.write` so it bypasses Ink's render pipeline. iTerm2 requires Preferences → Advanced → "Allow clipboard read/write from shell" for OSC 52 to take effect.
- `process.stdout.write` for OSC 52 must bypass Ink — the same pattern `apps/cli/src/mouseMode.ts` uses for `\x1b[?1006h`.

## Workflow

- Conventional Commits (`feat(scope): …`, `fix(scope): …`, `chore: …`, `docs: …`)
- No CI / no `.github/` — no GitHub Actions, PR templates, or Dependabot. If CI is added, wire it from scratch.

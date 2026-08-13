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

- `bun install` — install (pinned exact versions per `bunfig.toml`; lockfile is intentionally untracked, see `.gitignore`); never introduce npm/yarn/pnpm lockfiles
- `bun run cli <nickname> [signalingPort] [signalingHost]` — run the terminal app
- `bun test` — run all tests (Bun test runner; imports `from "bun:test"`)
- `bun run build` — `bun run --filter '*' build` (per-package `tsc -p tsconfig.json`, output to `dist/`); also produces `apps/cli/dist/main.js`, which `package:cli` reads as the entry
- `bun run lint` — `biome check .`
- `bun run format` — `biome format --write .`
- `bun run package:cli --target <linux-x64|darwin-arm64|windows-x64> --tag <vX.Y.Z>` — bundle `@wenchat/cli` into a single self-contained binary via `@yao-pkg/pkg@6.22.0` (writes `dist-release/wenchat[.exe]`); requires `bun run build` to have populated `apps/cli/dist/main.js` first
- `bun scripts/smoke-lan-bind.ts` — LAN-bind regression check; run after any `signaling.ts` bind change

There is no `bun run check`; `biome` only lints, it does not typecheck.

## Runtimes

- **CLI runs on Node.js (≥ 20), not Bun** — Bun has an mDNS bind bug on macOS (commit `d02de50`). Do not switch the CLI runtime back to Bun.
- **Bun drives install / build / test / package.** Bun version is not pinned.
- **Packed binaries embed Node 20 + yoga** — `bun run package:cli` produces a single executable that needs no system Node; this is what end users download from GitHub Releases.
- `process.env` is not used anywhere; configuration is via CLI positional args.

## CLI subcommands

`apps/cli/src/main.tsx` dispatches subcommands **before** the TUI safety net / alt-screen / React mount, so `wenchat version`, `wenchat help`, and `wenchat upgrade` never touch the terminal:

- `version` / `--version` / `-v` — print version, exit 0. In dev (`bun run cli`) the version reads as `"dev"`; in a packed binary it reads from `globalThis.__WENCHAT_VERSION__`, which `package:cli` injects via esbuild `define`.
- `help` / `--help` / `-h` — print help text, exit 0 (string lives in `apps/cli/src/updater.ts` next to the other CLI-facing constants).
- `upgrade` / `update` [`--check-only`] — query the GitHub Releases API for `dkisser/wenchat`, find the asset for the current platform via `detectTarget()` (matrix must match `.github/workflows/release.yml` exactly: linux-x64 / darwin-arm64 / windows-x64), download to a temp file, then atomically `rename(2)` over the running executable. POSIX works because a running ELF can be renamed; Windows stages the file and prints a one-line manual swap instruction. Exit codes: `0` = success / up-to-date, `1` = network or IO error, `2` = unsupported platform, `3` = no asset for this platform.

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

## CI and releases

- **CI** — `.github/workflows/ci.yml` runs on push and PR to `main` (ubuntu-latest). Concurrency cancels in-progress runs on the same ref so a fast-forward on main doesn't pile up queued PR re-runs. Pipeline: `bun install --frozen-lockfile` → `bun run lint` → `bun test` → `bun run build` → `bun scripts/smoke-lan-bind.ts`. The smoke step guards the LAN-bind behavior introduced in `d02de50` (loopback blocked, LAN reachable) which is the bug Bun's mDNS implementation hit on macOS.
- **Release** — `.github/workflows/release.yml` triggers on `v*` tags. Matrix: linux-x64 / darwin-arm64 / windows-x64 via `bun run package:cli`; each platform uploads its binary as a per-platform artifact. The install scripts (`scripts/install.sh` for POSIX, `scripts/install.ps1` for Windows) go up as a separate artifact so users can curl them even if a binary build fails. A final publish job downloads everything, generates `SHA256SUMS`, and creates the GitHub Release with install instructions in the body. Release bodies intentionally point users at `raw.githubusercontent.com/.../scripts/install.sh` (not at the asset) so the installer script is always reachable from a clean machine with no prior install.
- **Asset naming** — `wenchat-<tag>-<target>[.exe]` (e.g. `wenchat-v0.1.0-linux-x64`, `wenchat-v0.1.0-windows-x64.exe`). The same string is built by `assetNameFor(tag, target)` in `apps/cli/src/updater.ts` and by the `release.yml` artifact name, so a mismatch would surface as "no asset for this platform" at upgrade time.
- **Versioning** — versions are Git tags of the form `vMAJOR.MINOR.PATCH`. `isNewer()` in `updater.ts` is a dotted-tuple compare; pre-release suffixes (e.g. `-rc.1`) are not handled yet — plug in semver if/when we need them.
- **No Dependabot / no PR templates** — Dependabot would churn the lockfile against `bunfig.toml`'s exact-pinning policy. PR templates were deliberately not added; if a contributor needs the checklist, link to `.github/ISSUE_TEMPLATE/` only when there's a real reason.

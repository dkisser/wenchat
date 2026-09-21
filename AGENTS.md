# AGENTS.md

Project constraints for working on WenChat. Feature-level implementation notes live in `docs/devops/` and are linked where relevant.

## Project

WenChat is a LAN-only, peer-to-peer terminal chat tool: mDNS (Bonjour) discovery, in-process HTTP signaling, chat and file transfer over WebRTC `DataChannel`, rendered in an Ink (React-based) TUI.

## Monorepo layout

Bun workspaces (`workspaces: ["apps/*", "packages/*"]`); inter-package refs use `"workspace:*"`. No pnpm/yarn/turbo/nx/lerna.

- `apps/cli` — `@wenchat/cli` — Ink TUI entry point
- `packages/core` — `@wenchat/core` — WebRTC, mDNS, signaling, peer transport
- `packages/protocol` — `@wenchat/protocol` — message types, chunk framing, codec (Zod-validated)
- `packages/ui` — `@wenchat/ui` — Ink components + helpers

Package-specific gotchas — read on demand when editing those paths:
- `docs/devops/cli.md` — for `apps/cli/**`
- `docs/devops/core.md` — for `packages/core/**`

## Canonical commands

- `bun install` — install (pinned exact versions per `bunfig.toml`; `bun.lock` is tracked and CI enforces it via `--frozen-lockfile` — regenerate and commit it when dependencies change); never introduce npm/yarn/pnpm lockfiles
- `bun run cli start [nickname] [signalingPort] [signalingHost]` — run the terminal app
  (also accepts `bun run cli start --name <nickname> --port <port> --host <host>`)
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

## CLI constraints

- The `start` subcommand is required; bare `wenchat <nickname> ...` is not accepted.
- `version` / `help` / `upgrade` dispatch before the TUI safety net / alt-screen / React mount and must never touch the terminal.
- Release asset naming must stay in sync between `assetNameFor(tag, target)` in `apps/cli/src/updater.ts` and the `release.yml` artifact names (matrix: linux-x64 / darwin-arm64 / windows-x64); a mismatch surfaces at upgrade time as "no asset for this platform".
- Full subcommand/upgrade behavior spec (exit codes, download flow): `docs/devops/cli-subcommands.md`

## Code style

- **Tabs for indent, 100-char line width** (Biome config)
- **`type`, not `interface`; no `enum`** — use literal-string discriminants for unions
- **Named exports only**, no default exports
- **Type-only imports** for types
- Strict TS is on: `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`
- Per-package `tsconfig.json` excludes `src/**/*.test.ts(x)` from build output (no-op after the per-package `tests/` migration, kept defensively)
- Logger: `pino` (used in `@wenchat/core` and `@wenchat/cli`); avoid `console.log` in app/package source
- **Runtime validation: use Zod for every IO boundary.** External data — wire frames (codec), JSONL on disk (outbox), env vars, CLI args, mDNS TXT records, user input — must be parsed via a Zod schema; do not hand-roll validators for shape/range checks. Each package that needs runtime validation declares `zod` in its `dependencies` with the **exact pinned version** (matching `bunfig.toml`'s exact-pinning policy — e.g. `"4.6.5"`). All packages must pin to the same version; `bun.lock` is the source of truth. Schemas for cross-package wire types live in `@wenchat/protocol`; schemas for local IO live in the consuming package. `z.infer<typeof Schema>` is the canonical way to derive TS types from a schema — do not maintain a parallel hand-written type.

## Testing

- Bun's built-in test runner; tests live under each package's `tests/` directory, mirroring the source tree: `apps/cli/tests/` (no subdirs), `packages/core/tests/{unit,integration}/`, `packages/protocol/tests/`, `packages/ui/tests/{components,helpers}/`. Filename is `*.test.ts` / `*.test.tsx`. Tests reference production code via relative path (e.g. `../../src/peer`) or the existing workspace aliases (`@wenchat/protocol`).
- React/Ink components use `ink-testing-library`
- Integration tests wire two `PeerConnection`s on 127.0.0.1 with `setInterval` polls — slow by design (~5s timeouts); don't "fix" the speed.

## Workflow & releases

- Conventional Commits (`feat(scope): …`, `fix(scope): …`, `chore: …`, `docs: …`)
- Versions are git tags of the form `vMAJOR.MINOR.PATCH`; `isNewer()` in `updater.ts` is a dotted-tuple compare with no prerelease handling — don't tag `-rc`-style versions.
- **No Dependabot** — it would churn the lockfile against `bunfig.toml`'s exact-pinning policy. **No PR templates.** Don't add either without an explicit reason.

## Reference docs

Feature-level implementation notes, kept out of this file on purpose — consult when touching the relevant area:

- `docs/devops/cli.md` — `apps/cli` gotchas
- `docs/devops/core.md` — `packages/core` gotchas
- `docs/devops/cli-subcommands.md` — CLI subcommand and upgrade behavior spec
- `docs/devops/ui-rendering.md` — markdown rendering, clipboard, OSC 52, mouse invariants
- `docs/devops/ci-release.md` — CI pipeline, release workflow, asset naming, versioning details
- `docs/devops/known-issues.md` — diagnosed-but-unfixed defects (reconnect glare, werift T3 freeze) with their log signatures

## Domain model & decisions

- `CONTEXT.md` — project glossary (PeerConnection / Session / DataChannel / Heartbeat / outbox / ACK / TOFU …). **Read first** when introducing new vocabulary or before adding a new package boundary.
- `docs/adr/` — accepted and proposed architectural decisions. Cross-reference the relevant ADR when touching code that implements or contradicts one.
  - `0001-application-layer-message-reliability.md` — Stage 1 roadmap (per-peer `seq` + ACK + persistent outbox + chunk-level ACK for file transfer; transport stays `werift` WebRTC DataChannel).
  - `0002-cross-network-transport-evaluation.md` — Stage 2 placeholder (QUIC evaluation, triggered by cross-network reach requirements).
  - `0003-stage-1-wire-format.md` — Stage 1 implementation contract (locks all open questions from the plan: seq width, ACK shape/cadence, outbox format, receive window size, chunk vs outbox boundary).
- `docs/devops/stage-1-implementation-plan.md` — work breakdown for Stage 1 (6-PR additive stack). Read alongside ADR 0001 + 0003 when starting any PR in that stack.

# CLI subcommands spec

Moved verbatim from `CLAUDE.md` / `AGENTS.md` (was the "CLI subcommands" section). Behavior spec for the dispatch in `apps/cli/src/main.tsx`.

`apps/cli/src/main.tsx` dispatches subcommands **before** the TUI safety net / alt-screen / React mount, so `wenchat start`, `wenchat version`, `wenchat help`, and `wenchat upgrade` never touch the terminal:

- `start [nickname] [signalingPort] [signalingHost]` / `start --name <nickname> --port <port> --host <host>` — launch the TUI chat session. Bare `wenchat <nickname> ...` is no longer accepted; the `start` subcommand is required.
- `version` / `--version` / `-v` — print version, exit 0. In dev (`bun run cli`) the version reads as `"dev"`; in a packed binary it reads from `globalThis.__WENCHAT_VERSION__`, which `package:cli` injects via esbuild `define`.
- `help` / `--help` / `-h` — print help text, exit 0 (string lives in `apps/cli/src/updater.ts` next to the other CLI-facing constants).
- `upgrade` / `update` [`--check-only`] — query the GitHub Releases API for `dkisser/wenchat`, find the asset for the current platform via `detectTarget()` (matrix must match `.github/workflows/release.yml` exactly: linux-x64 / darwin-arm64 / windows-x64), download to a temp file, then atomically `rename(2)` over the running executable. POSIX works because a running ELF can be renamed; Windows stages the file and prints a one-line manual swap instruction. Exit codes: `0` = success / up-to-date, `1` = network or IO error, `2` = unsupported platform, `3` = no asset for this platform.

---
paths: ["apps/cli/**"]
---

# CLI-specific gotchas (`apps/cli`)

## Runtime = Node, not Bun

The CLI deliberately runs through `tsx` on Node.js, not Bun, due to a Bun mDNS bind bug on macOS. The README and the long header comment at the top of `apps/cli/src/main.tsx` both document this. Commit `d02de50` is the authoritative explanation. Do not switch the CLI runtime back to Bun.

## Alt-screen + mouse-tracking safety net + `exitOnCtrlC` are load-bearing

`apps/cli/src/main.tsx`:
- Disables Ink's `exitOnCtrlC`
- Calls `installTerminalSafetyNet([exitMouseMode, exitAltScreen])` before mounting
- Enters the alt screen, then mouse tracking (unless `--no-mouse`)
- Calls `exitMouseMode()` + `exitAltScreen()` + `process.exit(0)` only after `instance.waitUntilExit()`

A recent regression reintroduced `exitOnCtrlC` and produced a frozen terminal on exit. Keep the order: disable → install safety net → enter alt screen → enter mouse mode → mount → wait → exit mouse mode → exit alt screen → `process.exit(0)`.

**Why one safety net, not one per mode:** the SIGINT handler calls `process.exit(130)`. Node runs listeners in registration order, so the first handler to fire terminates the process and the second never executes — two parallel nets would leak whichever escape sequence lost the registration race. `installTerminalSafetyNet` runs the releases in array order.

## CLI args semantics

The CLI now requires the explicit `start` subcommand. `parseCliArgs` in
`apps/cli/src/parseArgs.ts` turns argv into a `CliAction`; `main.tsx` only
reaches the TUI for `action.kind === "start"`.

- `wenchat start [nickname] [signalingPort] [signalingHost]` — positional form
- `wenchat start --name <nickname> --port <port> --host <host>` — flag form
- `--no-mouse` can be appended to either form to disable mouse tracking
- `nickname` defaults to `os.hostname()`, then `"user"`
- `signalingPort` defaults to `0` (OS-assigned)
- `signalingHost` omitted on an interactive run opens the `HostPicker`; omitted
  on a non-interactive run falls back to `getLanHost()`

Bare `wenchat <nickname> ...` is **not** accepted anymore and prints an
"Unknown subcommand" error.

Never default to `127.0.0.1` — loopback cannot be reached by LAN peers.

This nickname is just an mDNS peer display name. It does **not** write `/etc/hostname` or `scutil`.

## Bind address vs advertise address

`PeerConnection.startListening(port, bindHost, advertiseHost = bindHost)` takes both. They are equal for a concrete address; they differ only for the `0.0.0.0` wildcard the picker offers. Binding the wildcard is fine, but publishing it is not — a peer that reads `"0.0.0.0"` out of our mDNS TXT record (or off our SDP offer) would dial its own loopback. `App` runs the bind address through `resolveAdvertiseHost()` (`packages/core/src/network.ts`) and feeds the result to both `discovery.start()` and the third `startListening` argument.

## The startup picker phase is gated, and the gate is load-bearing

`App` holds `bindHost: string | null`. The mount effect early-returns `undefined` while it is null, so **nothing binds a port or publishes over mDNS until the user picks**. The early return must stay `return undefined` (not a bare `return`) — `noImplicitReturns` rejects a bare one once the other path returns a cleanup.

The picker branch must also stay *below* every hook call: leaving the phase is a re-render of the same component, and React requires a stable hook order.

The picking-phase tree renders only `StatusBar` + `HostPicker` — deliberately no `InputBox`. That is what keeps InputBox's Up/Down history recall from fighting the picker for the same arrow keys, so no `isActive` gating is needed.


## macOS Bonjour "name changed" alert is expected

When the mDNS instance name changes (e.g. between launches with different nicknames), `mDNSResponder` reflects the Bonjour service instance name back into System Settings / Sharing. This is not wenchat modifying the system hostname. If the user complains about it, point them at the comment block at the top of `apps/cli/src/main.tsx`.

## Stress test for bind logic

When changing bind/peer logic, run `bun scripts/smoke-lan-bind.ts` from the repo root. Loopback requests should fail; LAN requests should succeed.

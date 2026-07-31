---
paths: ["apps/cli/**"]
---

# CLI-specific gotchas (`apps/cli`)

## Runtime = Node, not Bun

The CLI deliberately runs through `tsx` on Node.js, not Bun, due to a Bun mDNS bind bug on macOS. The README and the long header comment at the top of `apps/cli/src/main.tsx` both document this. Commit `d02de50` is the authoritative explanation. Do not switch the CLI runtime back to Bun.

## Alt-screen buffer + `exitOnCtrlC` are load-bearing

`apps/cli/src/main.tsx`:
- Disables Ink's `exitOnCtrlC`
- Calls `installAltScreenSafetyNet()` before mounting
- Calls `exitAltScreen()` + `process.exit(0)` only after `instance.waitUntilExit()`

A recent regression reintroduced `exitOnCtrlC` and produced a frozen terminal on exit. Keep the order: disable → install alt screen → mount → wait → exit alt screen → `process.exit(0)`.

## CLI args semantics

- `args[0]` — display name (defaults to `user-<random>`)
- `args[1]` — signaling port (`0` means OS-assigned)
- `args[2]` — signaling host override (defaults to LAN IPv4 from `getLanHost()`, **not** `127.0.0.1` — loopback cannot be reached by LAN peers)

This nickname is just an mDNS peer display name. It does **not** write `/etc/hostname` or `scutil`.

## macOS Bonjour "name changed" alert is expected

When the mDNS instance name changes (e.g. between launches with different nicknames), `mDNSResponder` reflects the Bonjour service instance name back into System Settings / Sharing. This is not wenchat modifying the system hostname. If the user complains about it, point them at the comment block at the top of `apps/cli/src/main.tsx`.

## Stress test for bind logic

When changing bind/peer logic, run `bun scripts/smoke-lan-bind.ts` from the repo root. Loopback requests should fail; LAN requests should succeed.

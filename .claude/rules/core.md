---
paths: ["packages/core/**"]
---

# Core-specific gotchas (`packages/core`)

## Signaling must bind LAN, not loopback

`signaling.ts` binds the LAN IPv4 chosen by `getLanHost()` (`packages/core/src/network.ts`) — the first non-internal IPv4 interface. Loopback (`127.0.0.0/8`) is excluded so that LAN peers can reach the signaling server, while loopback-only requests (e.g. from the smoke script) deliberately fail.

If you change bind logic, also re-run `bun scripts/smoke-lan-bind.ts` and verify the regressions it asserts.

## Multi-homed hosts

`getLanHost()` picks the first non-internal IPv4. On a multi-homed host with several NICs (e.g. Wi-Fi + wired + VPN), the choice is implementation-defined. The only override is the third CLI positional arg (`signalingHost`).

## mDNS discovery

`packages/core/src/discovery.ts` uses `bonjour-service`. It publishes the LAN-addressable signaling endpoint that `signaling.ts` binds. Note: `apps/cli/src/App.tsx` calls `discovery.start(...).catch(() => {})` — discovery errors are silently swallowed at the CLI boundary. If you add a logging path, surface those errors there instead of swallowing.

## WebRTC with werift

`werift` is a pure-JS WebRTC implementation. DataChannel traffic is plaintext over `DataChannel` — DTLS provides in-transit integrity but there is no app-layer encryption. If adding crypto, do it in `@wenchat/protocol` or above, not in this package.

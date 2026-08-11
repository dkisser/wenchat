---
paths: ["packages/core/**"]
---

# Core-specific gotchas (`packages/core`)

## Signaling must bind LAN, not loopback

`signaling.ts` binds the LAN IPv4 chosen by `getLanHost()` (`packages/core/src/network.ts`) — the first non-internal IPv4 interface. Loopback (`127.0.0.0/8`) is excluded so that LAN peers can reach the signaling server, while loopback-only requests (e.g. from the smoke script) deliberately fail.

If you change bind logic, also re-run `bun scripts/smoke-lan-bind.ts` and verify the regressions it asserts.

## Multi-homed hosts

`getLanHost()` picks the first non-internal IPv4 in `os.networkInterfaces()` enumeration order. On a multi-homed host with several NICs (e.g. Wi-Fi + wired + VPN), that choice is implementation-defined — which is why the CLI now shows a startup picker (`listBindCandidates()` + `HostPicker`) whenever no host was passed on an interactive run. The third CLI positional arg still overrides everything.

`listBindCandidates()` must keep returning LAN entries in raw enumeration order, so its first entry stays identical to `getLanHost()`. Sorting by NIC name would make the picker's default disagree with what a non-interactive run binds. Tests get determinism by injecting an interfaces record, not by changing the production ordering.

## mDNS discovery

`packages/core/src/discovery.ts` uses `bonjour-service`. It publishes the LAN-addressable signaling endpoint that `signaling.ts` binds. Note: `apps/cli/src/App.tsx` calls `discovery.start(...).catch(() => {})` — discovery errors are silently swallowed at the CLI boundary. If you add a logging path, surface those errors there instead of swallowing.

## WebRTC with werift

`werift` is a pure-JS WebRTC implementation. DataChannel traffic is plaintext over `DataChannel` — DTLS provides in-transit integrity but there is no app-layer encryption. If adding crypto, do it in `@wenchat/protocol` or above, not in this package.

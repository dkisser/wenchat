---
paths: ["packages/core/**"]
---

# Core-specific gotchas (`packages/core`)

## Signaling must bind LAN, not loopback

`signaling.ts` binds the LAN IPv4 chosen by `getLanHost()` (`packages/core/src/network.ts`) — the first non-internal IPv4 interface. Loopback (`127.0.0.0/8`) is excluded so that LAN peers can reach the signaling server, while loopback-only requests (e.g. from the smoke script) deliberately fail.

If you change bind logic, also re-run `bun scripts/smoke-lan-bind.ts` and verify the regressions it asserts.

## Teardown intent goes over HTTP, never the data channel

The signaling server carries four endpoints: `/offer`, `/candidate`, `/bye`, `/health`. The `/bye` endpoint is the authoritative "I left on purpose" signal — `PeerConnection.closeGracefully` awaits the HTTP 200 before calling `pc.close()`, so the peer has recorded the reason before any SCTP ABORT exists. Do NOT reintroduce in-band goodbyes as the primary mechanism: a DataChannel `bye` races the ABORT that teardown queues behind it, and no sender-side flush (bufferedAmount, werift outboundQueue, forcing `sctp.transmit()`) can close that race — the guarantee lives on the receiver. `Session.sendBye` survives only as a best-effort compat shim for pre-`/bye` builds.

`/bye` payloads carry `fromHost`/`fromPort` and the receiver matches them against the live session's remote endpoint — keep that check: a late bye from a previous peer must not tear down a new session.

`/health` backs `probeSignaling()`, which the CLI uses before the first auto-reconnect to tell "peer's process exited" (ECONNREFUSED → don't redial) from "network partition" (timeout → redial). Note the runtime split: Node's undici reports refusal as `cause.code === "ECONNREFUSED"`, Bun as top-level `code === "ConnectionRefused"` — the classifier accepts both.

## Multi-homed hosts

`getLanHost()` picks the first non-internal IPv4 in `os.networkInterfaces()` enumeration order. On a multi-homed host with several NICs (e.g. Wi-Fi + wired + VPN), that choice is implementation-defined — which is why the CLI now shows a startup picker (`listBindCandidates()` + `HostPicker`) whenever no host was passed on an interactive run. The third CLI positional arg still overrides everything.

`listBindCandidates()` must keep returning LAN entries in raw enumeration order, so its first entry stays identical to `getLanHost()`. Sorting by NIC name would make the picker's default disagree with what a non-interactive run binds. Tests get determinism by injecting an interfaces record, not by changing the production ordering.

## mDNS discovery

`packages/core/src/discovery.ts` uses `bonjour-service`. It publishes the LAN-addressable signaling endpoint that `signaling.ts` binds. Note: `apps/cli/src/App.tsx` calls `discovery.start(...).catch(() => {})` — discovery errors are silently swallowed at the CLI boundary. If you add a logging path, surface those errors there instead of swallowing.

## WebRTC with werift

`werift` is a pure-JS WebRTC implementation. DataChannel traffic is plaintext over `DataChannel` — DTLS provides in-transit integrity but there is no app-layer encryption. If adding crypto, do it in `@wenchat/protocol` or above, not in this package.

## Test gotchas — bun:test handler ordering

`bun:test` installs its own `uncaughtException` handler **during runner bootstrap, before any test code runs**. Consequence: `process.on('uncaughtException', …)` and even `process.prependListener('uncaughtException', …)` both attach AFTER bun:test's handler, so the test runner's handler always fires first and converts EventEmitter `'error'` events into test failures before user code can suppress them.

`process.setUncaughtExceptionCaptureCallback` looks like the official knob but bun-types does not declare it; behaviour is undefined under bun:test.

The only reliable lever is **prototype monkey-patching the emitter that raises `'error'`**. For `dgram.Socket` (used by werift's STUN socket), patch `dgram.Socket.prototype.emit` to short-circuit the `error` event when `err.code === 'ECONNREFUSED'` / `'EHOSTUNREACH'` — return `false` as if no listener were attached, so the EventEmitter default (throw as uncaughtException) never fires. macOS silently drops the ICMP for closed UDP ports, so this is Linux-only in practice.

The reusable helper lives at `packages/core/tests/helpers/udpSuppression.ts`. Import and call inside an affected test, `restore()` in `finally`:

```ts
import { suppressUdpRefused } from "../helpers/udpSuppression";
// …
const restore = suppressUdpRefused();
try {
	// … werift / UDP / STUN code …
} finally {
	restore();
}
```

The helper is idempotent (guarded by `Symbol.for('wenchat.peer-test.udp-suppressed')`) so nested calls are safe.

If a future test needs to suppress a different error family on a different emitter, copy the pattern — do not try `process.on('uncaughtException', …)` again; the trap is identical.

## Outbox on disk

`OutboxStore` (PR-2, `packages/core/src/outbox.ts`) is the per-peer persistent queue for application-message reliability (ADR 0001 + ADR 0003). One store per remote peer; the caller (`peer.ts` in PR-3) constructs the path, the store itself knows nothing about `localId` or `~/.wenchat`. The convention is `<workspaceRoot>/outbox/<peerId>.jsonl`.

### File format

JSONL, one entry per line. Three entry kinds (Zod discriminated union on `kind`):

| `kind`  | Shape                                   | Written by                | Meaning                                                                            |
| ------- | --------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------- |
| `head`  | `{ kind: "head", head: N }`             | PR-3's sender scheduler   | Fast-recovery high-water seq (ADR 0003 Q10). PR-2 never writes this; reading is supported so PR-3 can add the writer without changing readers. |
| `msg`   | `{ kind: "msg", seq: N, encoded: "…" }` | PR-3's sender scheduler   | One outbound application message, frozen as the encoded wire payload. The sender stores what it SENT, not what it meant, so a retransmit reproduces the exact bytes. |
| `ack`   | `{ kind: "ack", seq: N }`               | PR-3 on inbound `message-ack` | Soft tombstone (ADR 0003 Q6) — receiver has confirmed `seq` N, and per Q2 the ACK value is "highest contiguous", so `ack=N` implicitly covers `1..N`. |

### Crash recovery

The file is read line-by-line on every `unackedFrom` / `getHead` call. Any line that fails Zod validation (partial write from a mid-`fsync` kill, garbage bytes, anything else) is **skipped** with a `pino warn` — the store never throws on corrupt input. The worst case is "the last un-flight entry got lost", which the retransmit loop surfaces as `outbox-abandoned` (PR-3) rather than corrupting the whole queue.

`OutboxStore.append` rejects any payload containing a literal `"\n"` (would corrupt JSONL) — the validation runs BEFORE `fsync`, so a rejected write leaves nothing on disk.

### Fsync policy

**Every** append and `markAcked` does one `write` + one `fsync` before the promise resolves. This is per ADR 0003 F.1: the alternative (in-memory bounded queue + background flusher) opens a recovery window of unflushed entries that a hard kill would drop. Chat traffic is human-limited, so the per-message cost is acceptable; bulk file transfer goes through `fileTransfer.ts` and does NOT touch the outbox (ADR 0003 F.5) — the bitmap ACK is the recovery channel for chunks.

A future PR may add a bounded in-memory queue (suggested cap: 16 unflushed) if real workloads show the per-message `fsync` is a bottleneck. The current contract is "one `fsync` per `append`"; do not change it without an ADR amendment.

### Compaction

`OutboxStore.compact()` rewrites the file via a temp file + `rename` (atomic on POSIX), dropping every `msg` and `ack` entry whose `seq <= head`. The compactor is exposed as a public method so PR-3 can call it from its background scheduler. ADR 0003 Q6 fixes the trigger at "outbox > 1 MiB AND head < tail − 1 KiB"; PR-3 owns the policy. Compacting when `head === 0` is a no-op (nothing to drop).

### Concurrent writers

Every mutator funnels through an internal promise queue. Two `await store.append(...)` calls racing each other serialize through that chain, so on-disk order matches the await order. PR-3's sender relies on this to guarantee "outbox order = wire order".

### Path discipline

`OutboxStore` does NOT inspect `~/.wenchat` or derive paths from `localId` — it stores whatever the caller passes. Tests use `mkdtemp(os.tmpdir(), …)` to stay out of `~/.wenchat`. The constructor does not touch the filesystem; the first `append` lazily `mkdir -p`s the parent directory.

### `close()` semantics

Idempotent. Sets an internal `closed` flag; every subsequent mutator (`append`, `markAcked`, `unackedFrom`, `getHead`, `compact`) rejects with `OutboxStore: operation on a closed store`. The reopen path is "construct a fresh `OutboxStore(path)` and read the file" — there is no `open()` method.

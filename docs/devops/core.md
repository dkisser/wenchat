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

### PR-2 review fixes (landed in PR-3)

The outbox shipped with two review-driven edges that the subsequent PR addressed; documenting them here so a future reader does not "re-fix" them or treat them as regressions:

- **Monotonic ACK guard** (`OutboxStore.markAcked`): the receiver's ACK value is "highest contiguous seq received" (ADR 0003 Q2), so a buggy peer or wire reorder that delivers `ack(5)` after `ack(10)` must NOT roll the head backward. `markAcked` now caches the highest head it has written (seeded lazily from `getHead()` for crash-recovery correctness) and refuses to write a tombstone for any `seq <= cachedHead`. The check + write is held inside the `withLock` chain so two concurrent calls cannot both observe a stale cache.
- **Unparseable-line log shape** (`OutboxStore.readEntries`): the warn that surfaces on a corrupt line used to include the raw bytes — which can carry user payload. The new shape is `{ lineLength, lineHash }` where `lineHash` is the first 8 hex chars of the line's sha256. Enough to correlate postmortem with the on-disk byte range, never enough to leak the message.
- **Stale compaction cleanup** (`PeerConnection.startListening`): the compactor writes a temp sibling (`<filePath>.compact-<pid>-<ts>`) and renames it atomically over the live file. A crash between the write and the rename leaves the temp behind; `startListening` now scans the outbox directory for `*.compact-*` and best-effort `unlink`s them. Missing dir / undeletable file is not fatal — the next launch retries.

## MessageAckScheduler

`MessageAckScheduler` (PR-3 + PR-4, `packages/core/src/messageAck.ts`) is the per-peer application-layer reliability state machine. One instance lives on `PeerConnection`, created lazily on the first `connect()` / `acceptOffer()` for a given peer, and reused across `swapSession` so the seq counter, retransmit timers, and inbound contiguity state survive any transport swap (ADR 0003 Q10).

### Two roles share state

- **Sender:** `allocateSeq()` returns the next monotonic seq (loaded from `outbox.getHead()` on construction via `initFromOutbox`); `peer.ts::send()` appends the encoded payload to the outbox, registers a per-message retransmit timer with `scheduleRetransmit(seq, encoded)`, and dispatches the message on the wire.
- **Receiver:** `noteInbound(seq)` runs every inbound seq through the receive window (PR-4), increments the "since last ACK" counter, and emits an ACK per the trigger schedule. Inbound `message-ack` frames route to `noteAck(ack)` which clears matching retransmit timers and tombstone-writes via `outbox.markAcked`.

### ACK trigger (ADR 0003 Q3)

Whichever happens first:

| Trigger              | Cadence                                                |
| -------------------- | ------------------------------------------------------ |
| Idle timer           | 200 ms after the last `noteInbound`                    |
| Every-16 messages    | When `inboundCountSinceLastAck >= 16`                  |
| Session close        | `closeSession()` calls `flushAck()` before going dark  |
| Gap detected         | `noteInbound` returns `"gap"` → immediate `flushAck()` |

`flushAck()` is also exposed as a public method so the gap-detection path (PR-4) can call it without involving the cadence timers.

### Retransmit policy (ADR 0003 Q4)

- Initial delay: 2 s after `scheduleRetransmit`.
- Exponential backoff: ×2, capped at 30 s.
- Give up after 5 attempts: emit `outbox-abandoned` with the abandoned `seq`; the CLI surfaces this as a system message in PR-6.
- Each message has its own timer; `noteAck(ack)` clears every timer for `seq <= ack` in one pass.
- A retransmit re-emits the SAME bytes (`encoded` string) so the receiver's dedup catches anything it should not re-deliver.

### Event API

| Event              | When                                                  | Where subscribed                       |
| ------------------ | ----------------------------------------------------- | -------------------------------------- |
| `outbox-abandoned` | After 5 failed retransmits for a given `seq`          | `PeerConnection.onOutboxAbandoned(cb)` |
| `outbox-empty`     | Once per transition from non-empty → empty            | `PeerConnection.onOutboxEmpty(cb)`     |

Both are emitted through `PeerConnection`'s listener sets so the CLI can subscribe without reaching into the scheduler directly.

### Receive window (PR-4 — ADR 0003 Q7)

`ReceiveWindow` (new in PR-4, `packages/core/src/receiveWindow.ts`) is the receiver-side LRU dedup + gap detector. Default cap = 256 (ADR 0003 Q7); `MessageAckScheduler` constructs one per peer and feeds every inbound seq through it.

#### API

```ts
accept(seq: number): { status: "new" | "duplicate" | "gap", gapFrom?, gapTo? }
getHighestContiguous(): number
size(): number
clear(): void
```

- `"new"` — first sighting within the window; the caller forwards the message to user listeners. `highestContiguous` advances only when `seq === highestContiguous + 1` (with the cascade filling any in-window gap).
- `"duplicate"` — already in the window; the caller drops silently.
- `"gap"` — `seq > highestContiguous + 1`; the caller fires an immediate `message-ack` so the sender's retransmit timer can fill the hole. `gapFrom = highestContiguous + 1`, `gapTo = seq - 1`. `highestContiguous` does NOT advance on a gap — we are still missing everything in `gapFrom..gapTo`.

#### Why LRU at 256?

256 is "roughly a full backscroll of duplicates before eviction starts losing dedup". For a chat session the worst case is bursty duplication after reconnect. On eviction the next inbound seq triggers a gap → immediate ACK → retransmit covers the gap. The loss is recoverable, not silent.

#### Cascade fill

When `accept(seq)` advances `highestContiguous` by one step (`seq === highestContiguous + 1`), the implementation keeps advancing as long as `highestContiguous + 1` is already in the window. Without the cascade, a re-arrived out-of-order seq would leave the ACK value lagging behind what we actually hold — the sender would retransmit a seq we already have. With the cascade, every `flushAck()` reflects reality after the most recent `accept()`.

#### Cross-`swapSession` continuity

`MessageAckScheduler.closeSession()` calls `receiveWindow.clear()` — a fresh session starts with an empty window rather than inheriting stale dedup state. The scheduler's `seq` counter itself survives `swapSession` (per ADR 0003 Q10); the receiver-side contiguity is treated as a per-session invariant because the wire's notion of "fresh start" matches the window's. A reconnect to a different `peerId` (which constructs a new `MessageAckScheduler` and therefore a new `ReceiveWindow`) obviously resets both sides.

### Cross-`swapSession` continuity

The scheduler is sticky to the first peerId it was built for. `PeerConnection.swapSession` does NOT touch it — only the `sendAck` / `sendMessage` callbacks (which dispatch through `PeerConnection.session` — the new one) point at the fresh transport. This is what guarantees `seq` continuity across a network drop: a post-swap `allocateSeq()` returns `lastKnown + 1`, never resets to 1. The receive window's state similarly survives the swap; `closeSession` is the only thing that resets it (see above).

### PR-3 review fixes (landed in PR-4)

- **PR-3 bounded set replaced by ReceiveWindow.** The PR-3 `Set<number>` dedup (window of 64) is gone; `MessageAckScheduler.noteInbound` now delegates to a 256-entry LRU `ReceiveWindow`. The "duplicate vs new" contract is preserved; the new `"gap"` status adds the immediate-ACK trigger that ADR 0003 Q7 requires. The `recentInboundSeqs` field and the `DEDUP_WINDOW_SIZE = 64` constant are both removed from `messageAck.ts`.

## File transfer reliability (PR-5)

`FileSender` (PR-5, `packages/core/src/fileTransfer.ts`) is the per-peer chunk-level ACK sender. One instance lives on `PeerConnection`, created lazily on the first `sendFile` call, and reused across `swapSession` so the per-chunk unacked bitmap and retry timers survive any transport swap. Its sibling `FileReceiver` (extended in PR-5) maintains the receiver-side chunk bitmap and emits the ACK frames that drive selective retransmit.

### Per-transfer bitmap model

Both sides keep a per-`transferId` view of the chunks; the bitmap is the **only** recovery channel (ADR 0003 F.5 — chunks do not flow through the chat outbox):

| Side | State | Updates on | Cleared on |
|------|-------|-----------|-----------|
| Receiver | `receivedIndices: Set<number>` + `expectedNext` cursor | every accepted chunk | never (the set is the truth) |
| Sender | `unackedIndices: Map<number, true>` (LRU-capped at `DEFAULT_FILE_UNACKED_BITMAP_CAP = 256`) + per-chunk retry counters | every sent chunk | every inbound ACK that confirms the chunk |

`expectedNext` cascades through `receivedIndices` whenever the next expected chunk is already in the set — without the cascade, a re-arrived out-of-order seq would leave the contiguous cursor lagging the bitmap.

### ACK emission (ADR 0003 Q8)

`FileReceiver` emits a `FileChunkAckMessage { transferId, bitmap, lastIndex }` on whichever fires first:

| Trigger | When |
|---------|------|
| Every 32 received chunks | `chunksSinceLastAck >= FILE_CHUNK_ACK_INTERVAL (32)` |
| Out-of-order arrival | any chunk index `> expectedNext - 1` (the PR-5 "request retransmit" path; replaces the PR-1/2/3/4 "out-of-order chunk = protocol violation" rule) |
| `file-end` | the final ACK so the sender can fill any remaining gap |

`bitmap` is bit-per-chunk, LSB-first within each byte, covering indices `0..lastIndex` where `lastIndex` is the highest chunk index the receiver has any information about (not the contiguous cursor — see `buildChunkAckBitmap`'s doc). The sender treats `lastIndex < 0` (empty bitmap) as "no info, retransmit everything".

### Sender-side retransmit policy

`FileSender.noteChunkAck(payload)` reconciles the receiver's bitmap against the sender's `unackedIndices`:

- Bit `i` set → remove `i` from unacked, clear its retry counter + timer.
- Bit `i` clear (and `i <= lastIndex`) → ensure `i` is in unacked.
- After reconciliation, re-arm a retransmit timer for every still-unacked chunk. Initial delay `FILE_INITIAL_RETRANSMIT_MS = 200 ms` (faster than chat's 2 s because chunk retransmits are triggered by an ACK that already names the missing index), then `× 2` exponential backoff capped at `FILE_MAX_RETRANSMIT_MS = 30 s`. After `FILE_MAX_RETRANSMIT_ATTEMPTS = 5` failed attempts on any one chunk, the sender calls `onTransferAbandoned(transferId)` and emits a best-effort `file-abort` so the receiver can drop the partial temp file. PR-6 wires `onTransferAbandoned` to the chat log as a system message.

`unackedIndices` is LRU-evicted at `DEFAULT_FILE_UNACKED_BITMAP_CAP = 256` so a multi-thousand-chunk transfer doesn't pin proportional memory; the receiver's bitmap is the authoritative source of truth, so an evicted index re-added on the next ACK lands cleanly.

### Receiver-side "out-of-order = request retransmit"

The PR-1/2/3/4 `failTransfer("out-of-order chunk…")` rule was reframed in PR-5:

- **Before**: out-of-order arrival → `failed` event, temp file deleted, transfer aborts.
- **After**: out-of-order arrival → record the chunk (it lands at its own offset via `addUnicted`), cascade `expectedNext` if applicable, send a `FileChunkAckMessage` so the sender knows what's missing, and keep the transfer alive.

The transfer only fails when the **sender** gives up — five failed retries on any one chunk → `file-abort` → receiver's `failTransfer("aborted by peer: ...")`. This is the catastrophic-case path; the common path is "receiver asks, sender re-streams, transfer completes".

### Post-`file-end` validation delay

`FileReceiver.finishTransfer` schedules the final validation via `setTimeout(this.validationDelayMs)` (default 3000 ms) **only when** the post-file-end bitmap shows a gap (`expectedNext < totalChunks`). The wait runs **outside** the receiver's task queue so retransmit chunks can land during it; the deferred validation reads the (potentially fully-recovered) transfer state and either completes or fails. The happy path validates on the next event-loop tick with zero wait.

The default `validationDelayMs` of 3000 ms is the worst-case budget for: sender's first retransmit (200 ms) + ACK round-trip + N retransmit writes against the receiver's queue + sha256 read of the temp file. Tests that don't exercise the recovery path pass `validationDelayMs: 0` to keep happy-path latency deterministic; the `FileReceiver` constructor option is the public knob.

### Hash-from-disk at completion

Out-of-order reception means a running `Hash.update` would mix chunks in receive order, never matching the sha256 the sender wrote into `file-end`. PR-5 hashes the **on-disk file** at validation time (one `readFile` per transfer; sub-millisecond on a LAN disk) and compares to the announced checksum. The "exceeds announced file size" check stays at write time (per-chunk bounds against `chunk.index * FILE_CHUNK_SIZE`) so a malicious peer can't stream unbounded data.

### Chunks vs chat outbox

ADR 0003 F.5: file chunks do NOT flow through the chat outbox. The chunk-level bitmap ACK is the only recovery channel. The chat outbox carries `Message` (text, file-start/-end/-abort) and `MessageAck` for application reliability; `FileSender` is a parallel structure with its own state, retry budget, and abandonment event. A sender-side crash mid-transfer is recoverable only on the next process launch with a fresh transferId; a mid-transfer channel failure on the same process is handled by `FileSender`'s retry timer firing against the next session's channel (see `swapSession` notes below).

### Session swap continuity

`FileSender` survives `swapSession` like `MessageAckScheduler` does. The retry timers keep ticking across transport swaps; when the next session attaches, `getChannel()` returns the new transport and pending retransmits resume. A transfer that was abandoned in `swapSession` (e.g. the user pressed `/disconnect`) is left alone — the timer fires against `null` channel, re-arms, and eventually exhausts the 5-attempt budget. This matches the chat outbox's "no state loss across reconnect" guarantee (ADR 0003 Q10).

### Event API

| Event | When | Where subscribed |
|-------|------|------------------|
| `transfer-abandoned` | After 5 failed retransmits for any chunk | `PeerConnection.onTransferAbandoned(cb)` |

PR-6 wires `transfer-abandoned` to the chat log as a system message, parallel to `outbox-abandoned`.

### `SendChannel` getter discipline

`PeerConnection.sendFile` → `FileSender.sendFile` reaches the live transport via `Session.getSendChannel()`. The returned object's `bufferedAmount` and `isOpen` **must** be getters, not captured values: a `sendFile` loop reads `bufferedAmount` after every chunk to gate the high-water wait, and a stale snapshot value disables the backpressure path (the bug surfaces as "sendFile resolves in 11 ms for a 4 MiB file when high-water is supposed to pace it"). The getter pattern in `Session.getSendChannel` is the canonical reference; clone it for any future code that needs a `SendChannel`.

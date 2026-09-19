# Stage 1 Implementation Plan — Application-Layer Message Reliability

**Scope:** ADR 0001 — per-peer `seq` + ACK + persistent outbox + chunk-level ACK for file transfer, on top of the existing werift WebRTC DataChannel. Out of scope: Stage 2 transport evaluation.

**Repo anchors:** `packages/protocol`, `packages/core`, `apps/cli`. Pure application-layer change; no new npm dependencies, no native bindings, no signaling transport change.

---

## A. Decisions vs Open Questions

### A.1 Already decided by ADR 0001 (locked)

| Decision | Source |
|---|---|
| Per-peer monotonic `seq` for every outbound application message | ADR 0001 §Consequences |
| Receiver sends `MessageAck` frames declaring progress | ADR 0001 |
| Persistent outbox per peer under `~/.wenchat/<localId>/outbox/<peerId>.jsonl` | ADR 0001 + CONTEXT.md |
| Receive window deduplicates by `seq`, detects gaps | ADR 0001 |
| Chunk-level ACK + selective retransmit for file transfer | ADR 0001 |
| Transport stays werift WebRTC DataChannel | ADR 0001 §Considered Options (C chosen) |
| Both `HeartbeatScheduler` and `MessageAckScheduler` coexist | ADR 0001 §Consequences |
| Wire format must remain transport-agnostic for Stage 2 | ADR 0002 §Consequences |

### A.2 Open questions — must confirm before code starts

These are the decisions where the ADR is silent or where multiple reasonable answers exist. Each is annotated with a recommended default to unblock work if the user just signs off in bulk.

| # | Open question | Recommended default | Why |
|---|---|---|---|
| Q1 | `seq` field width: `u32` (4 B, 4 B/msg overhead, ~4.3B msgs/peer) vs `u64` (8 B, ~18 quintillion)? ADR 0001 §Consequences says `u64`. | **`u64`** | ADR 0001 explicitly says u64. A chat session of >4B messages is absurd but `u64` removes the rollover edge case forever, costs 4 extra bytes per JSON message, and JSON-encodes fine. |
| Q2 | ACK frame shape: single value `N` ("I have everything ≤ N") vs bitmap ("which `seq`s I have")? | **Single value `N` (highest contiguous)** for application messages; **bitmap per transferId** for file chunks | App messages: SCTP is ordered, so out-of-order delivery is not a wire concern — a gap is always a real loss. Single `N` is half a message and trivial to extend later. File chunks: ADR 0001 calls out "selective retransmit", which needs a bitmap. Keep them as two separate frame types, not one. |
| Q3 | ACK trigger cadence: per inbound message, time-windowed (e.g. every 200 ms), or byte-count threshold? | **Time-windowed (200 ms idle timer) + on every Nth message + on session close** | Per-message wastes bandwidth on chat bursts. Pure timer delays the first ACK by up to 200 ms. The hybrid avoids both. |
| Q4 | Per-message retransmit policy: fixed timeout, exponential backoff, max retries? | **Initial 2 s, exponential ×2, cap at 30 s, give up after 5 retries → emit `outbox-abandoned` event** | Matches heartbeat order of magnitude (2 s ping, 4 s watchdog). 5 × ~30 s ≈ 90 s ceiling; user has long since stopped waiting, so escalation is correct. |
| Q5 | Outbox file format: JSONL vs binary length-prefixed? | **JSONL** | Already documented in CONTEXT.md (`*.jsonl`). Append-friendly (one syscall per message), grep-friendly for debugging, recoverable from partial writes because each line is independently parseable. Binary framing buys nothing here — the wire itself is the binary layer. |
| Q6 | Outbox truncation: hard delete vs soft (tombstone line)? | **Soft tombstone** `{ "kind": "ack", "seq": 42 }` followed by periodic compaction | JSONL is append-only by convention. Hard delete requires read-rewrite of a file that may be growing under us; tombstones let the compactor rewrite the file when idle. Compaction triggered by "outbox > 1 MiB AND head < tail − 1 KiB". |
| Q7 | Receive window size: bounded by what? | **256 entries (default), LRU-evicted when full** | Worst case for a chat session is bursty duplication after reconnect. 256 is roughly a full backscroll of duplicates before eviction starts losing dedup. The gap-detector reads from this set, not from a sorted structure. |
| Q8 | File chunk-level ACK granularity: every chunk vs every Nth? | **Every 32nd chunk + on `file-end`** | Per-chunk ACK doubles the wire bytes for an 8 MiB file (128 chunks → 128 ACKs). Every-32 is one ACK per 2 MiB on the wire and keeps round-trips short enough that 64 KiB × 32 = 2 MiB of retransmit window at most. |
| Q9 | Heartbeat vs ACK scheduler: merge or coexist? | **Coexist** | Heartbeat is liveness-only and runs on a separate cadence (2 s ping, 4 s watchdog). ACK is data-flow. Merging them couples liveness to data plane and forces ACK to emit even when idle (which wastes bandwidth). ADR 0001 already calls for coexistence. |
| Q10 | Cross-`swapSession()` continuity: preserve `seq` counter? | **Preserve** | The whole point of `seq` is to survive a fresh SCTP association. If we reset on reconnect, the receiver's window restarts and the receiver sees "huge gap from 0 to N" → aborts the transfer as fraud. Outbox holds the truth; `seq` is its position. |
| Q11 | Backward compatibility with pre-Stage-1 builds (no `seq` on the wire)? | **Send `seq: undefined` → receiver treats legacy messages as in-order; new code sends `seq` always** | A `seq` field on a `Message` is additive: old receivers ignore unknown fields (they already do — see how `bye` was originally unknown). New receivers default `seq` to `null` when missing. No version byte needed. |
| Q12 | Do we surface ACK/outbox state to the TUI? | **No in this stage**; just log via pino and emit `outbox-abandoned` as a system message | The TUI already has 100-char-line-width discipline and chat-log capacity. A progress bar for "delivering message 42 of 47" is overkill; just show the chat message as before, and on give-up print `Failed to deliver: <id>`. |

---

## B. File Changes (by package)

### B.1 `packages/protocol/` — additive wire format only

`@wenchat/protocol` has zero runtime dependencies (see its `package.json`). All changes are additive type unions plus two constructors; no behavior change to existing types.

| File | Change |
|---|---|
| `packages/protocol/src/message.ts` | Add `seq: number \| null` to the shared envelope (extract a `MessageEnvelope` type if cleaner); leave existing message constructors alone. Add `MessageAckMessage` (`type: "message-ack"`, payload `{ ack: number }`) and `FileChunkAckMessage` (`type: "file-chunk-ack"`, payload `{ transferId: string; bitmap: Uint8Array; lastIndex: number }`). |
| `packages/protocol/src/codec.ts` | Add `"message-ack"`, `"file-chunk-ack"` to the `MESSAGE_TYPES` set. Reject frames with `seq < 0` or `seq > Number.MAX_SAFE_INTEGER` on decode — defensive narrowing before they hit `MessageAckScheduler`. |
| `packages/protocol/src/wire.ts` | No change. Both new ack types ride the existing JSON demux. File chunks stay binary-only (no `seq` on the chunk header — chunks carry their own `index` field already). |
| `packages/protocol/src/file.ts` | No change to constructors. (Q8 bitmap is computed in core, not in protocol.) |
| `packages/protocol/tests/codec.test.ts` | New: round-trip `message-ack` and `file-chunk-ack`; reject malformed `seq`. |
| `packages/protocol/tests/message.test.ts` | New: `seq` is preserved through `JSON.stringify`/`parse` for every variant. |

**Important constraint:** Do NOT introduce any non-zero-cost framing for chunks. Chunks already carry `index`; per ADR 0001 they don't need a separate per-peer `seq` field — the `transferId` + `index` pair is the chunk identity, and the bitmap ACK references both.

### B.2 `packages/core/` — new modules + wiring

| File | Change | Risk |
|---|---|---|
| `packages/core/src/outbox.ts` (NEW) | `OutboxStore` class. Methods: `append(seq, encoded)`, `markAcked(seq)`, `compact()`, `unackedFrom(seq)`, `close()`. JSONL append with `fsync` after every write (off the hot path of every message — see F.1). Per-peer instance held by `PeerConnection`. | Outbox IO is on every send path; must keep the happy-path cost under ~1 ms. |
| `packages/core/src/messageAck.ts` (NEW) | `MessageAckScheduler`. Owns: per-peer "highest contiguous seq received" counter (the receiver's `N`); outbound `MessageAck` timer (200 ms idle + every 16 messages); inbound `MessageAck` handler that calls `OutboxStore.markAcked`. Emits `outbox-empty` when the outbox drains to zero. | Receiver-side state must persist across `swapSession()` (Q10). |
| `packages/core/src/receiveWindow.ts` (NEW) | `ReceiveWindow` class. LRU `Set<number>` capped at 256 entries. Methods: `accept(seq)` → `{ status: "new" \| "duplicate" \| "gap", gapFrom?: number, gapTo?: number }`. The `gap` status is the trigger for the receiver to send an immediate `MessageAck(N)` and (for chunks) a `FileChunkAckMessage(bitmap)` so the sender can selectively retransmit. | Need careful gap-vs-duplicate distinction (a duplicate after a gap is still "we are missing seq X+1", not "we have seq X+1"). |
| `packages/core/src/peer.ts` | Inject `OutboxStore` (constructed in `startListening`, persisted to `~/.wenchat/<localId>/outbox/<peerId>.jsonl`); assign `seq` per send; fan outbound messages through outbox; on ack advance, drop outbox head. `swapSession()` keeps the `seq` counter, the outbox, the receive window — only the live transport is swapped. | Counter must be persisted to the outbox header (`{ "kind": "head", "head": N }`) so a process restart reads the right value. |
| `packages/core/src/transport.ts` | `DataTransport.onMessage` demux path: feed the receive window, then forward only `{ status: "new" }` messages to the listener fan-out. Drop `{ status: "duplicate" }` silently. Surface `{ status: "gap" }` to `MessageAckScheduler` to fire an immediate ACK. | `decodeWirePacket` already demuxes JSON vs binary; the receive window sits BETWEEN the codec and `notifyMessageListeners`. |
| `packages/core/src/session.ts` | On `attachTransport`, wire the receive window into the inbound path. On `close()`, snapshot the receive window head (highest contiguous seq) so `swapSession`'s new session can resume from the same point. No change to heartbeats (Q9). | Must not break the existing `terminated`/`pendingCloseReason` invariant — adding a window hook shouldn't introduce a second terminal emission. |
| `packages/core/src/fileTransfer.ts` | `sendFile`: keep an in-memory bitmap of unacked chunk indices per `transferId`; emit `FileChunkAckMessage` every 32 chunks AND on `file-end`. On inbound ACK, drop those indices from the "to-retransmit" set; if non-empty after the natural pause, send them again. `FileReceiver`: maintain its own per-transfer bitmap of received chunk indices; if `receivedIndex !== expectedIndex`, request a retransmit instead of failing the transfer outright (the existing `failTransfer("out-of-order chunk…")` path becomes the catastrophic case, not the normal one). | This is the largest behavioral change. The old `out-of-order chunk` rule was correct because SCTP is ordered; under the new model SCTP ordering is still true *within a session*, but the new chunk-level ACK means we *can* recover across sessions, so the rule needs to be reframed: "received an index that is not in our bitmap → ask for retransmit". |
| `packages/core/src/heartbeat.ts` | No change to the scheduler itself. New helper exported from peer.ts: when `MessageAckScheduler` is constructing an outbound ACK, it can piggyback on the heartbeat's existing `pong` reply timing — *not* as a wire optimization, but as a code path: `HeartbeatScheduler.handleIncoming` already calls `armWatchdog()` on pong, so a piggybacked ACK shares that path. (See Q9 — they're independent schedulers, just co-located in `peer.ts`.) | None significant. |
| `packages/core/src/index.ts` | Re-export new types: `OutboxStore`, `MessageAckScheduler`, `ReceiveWindow`. |

### B.3 `apps/cli/` — minor, gated on Q12

| File | Change |
|---|---|
| `apps/cli/src/connectionMachine.ts` | New effect: `outbox-abandoned` → emits a system message to the chat log via the existing `system-message` effect channel. No new `ConnectionPhase`. |
| `apps/cli/src/App.tsx` | Subscribe to `peerConnection.on("outbox-abandoned", …)` and translate into the existing `appendSystemMessage` helper. No TUI rendering changes. |
| `apps/cli/src/main.tsx` | No change (subcommand dispatch and logger init unaffected). |

If Q12 is answered "no UI changes at all", the two CLI files become docs-only updates (comments). The `outbox-abandoned` event still exists at the core boundary; the CLI just doesn't subscribe.

### B.4 `docs/` — new ADR + gotchas page

| File | Change |
|---|---|
| `docs/adr/0003-stage-1-wire-format.md` (NEW) | Lock the choices made by resolving A.2 questions (especially Q1, Q2, Q5, Q6). This is the ADR that prevents the next session from re-litigating them. Treat it as the implementation contract. |
| `docs/devops/core.md` | Add a new section "Outbox on disk" describing: path `~/.wenchat/<localId>/outbox/<peerId>.jsonl`; the `head` tombstone format; crash-recovery procedure (read head, scan unacked, replay on next session); the fsync policy. Also add a section "Receive window state across `swapSession`" noting that window state is in-memory only and re-synchronizes via the outbox replay on next session. |
| `docs/devops/cli.md` | If Q12 is answered "yes", add a one-paragraph note that `outbox-abandoned` surfaces as a chat-log line. If "no", no change. |
| `CONTEXT.md` | Add the new terms from this work into the glossary: `seq (per-peer sequence)`, `ACK`, `outbox`, `receive window`. Wait — those are already there (Stage 1 ADR section). Confirm during PR-6. |

---

## C. Test Matrix

All tests follow the existing style: `bun test`, helper module under `tests/helpers/`, polling via `setInterval` rather than `waitFor` (per AGENTS.md: "slow by design (~5s timeouts); don't 'fix' the speed"). UDP suppression for Linux CI is already wired.

### C.1 Unit (`packages/core/tests/unit/`, `packages/protocol/tests/`)

| Test file | Cases |
|---|---|
| `packages/protocol/tests/codec.test.ts` (extend) | Round-trip `message-ack`, `file-chunk-ack`; reject `seq` outside `[0, Number.MAX_SAFE_INTEGER]`; preserve `seq` through JSON parse. |
| `packages/core/tests/unit/outbox.test.ts` (NEW) | (1) `append(seq, encoded)` writes a valid JSONL line; (2) `markAcked(seq)` writes a tombstone; (3) `compact()` removes tombstones; (4) `unackedFrom(seq)` returns the expected slice; (5) crash recovery: write a partial file mid-line, reopen, returns zero unacked entries rather than throwing. (6) Concurrent `append` from two awaits serializes correctly (Promise chain discipline). |
| `packages/core/tests/unit/messageAck.test.ts` (NEW) | (1) Idle timer fires ACK after 200 ms; (2) Every-16-messages limit forces an early ACK; (3) Inbound ACK advances `OutboxStore.head`; (4) Inbound ACK with `ack < head` is silently ignored (replay attack / wire reorder); (5) `outbox-empty` event fires once when drain reaches zero. |
| `packages/core/tests/unit/receiveWindow.test.ts` (NEW) | (1) Sequential `accept(N)` → all "new"; (2) Duplicate `accept(N)` → "duplicate"; (3) `accept(N+5)` after `accept(N)` → "gap" with `gapFrom=N+1, gapTo=N+4`; (4) LRU eviction at 256 entries. |

### C.2 Integration (`packages/core/tests/integration/`)

Use the existing 127.0.0.1 + `setInterval` poll pattern. ~5 s typical timeout, ~30 s outer budget.

| Test file | Cases |
|---|---|
| `packages/core/tests/integration/reliability.test.ts` (NEW) | (1) Two peers exchange 50 messages; outbox on sender drains within 1 s after receiver hits `connected`; (2) Force-close sender mid-burst, restart, outbox replays; (3) Force-close receiver mid-burst, sender's retransmit timer fires, receiver rebuilds in-order; (4) Duplicate `seq` injection (simulate a buggy peer) is silently dropped, not double-displayed; (5) `swapSession` preserves `seq` continuity: pre-swap `seq=10`, post-swap continues from `seq=11`, receiver's gap detector does not flag. |
| `packages/core/tests/integration/fileTransfer.test.ts` (extend) | (1) Mid-transfer `_forceCloseActiveChannel`, sender retransmits unacked chunks, receiver completes transfer without "out-of-order chunk" error; (2) Reorder the chunk-arrival order artificially (drop chunks 5–7 from the wire, force a `FileChunkAckMessage(bitmap=…, lastIndex=4)`) and verify selective retransmit; (3) Receiver that drops the first 100 chunks sees `FileChunkAckMessage` with bitmap `[0..99]=missing` and the sender re-streams. |
| `packages/core/tests/integration/crashRecovery.test.ts` (NEW) | (1) Start a sender, queue 20 messages, `process.exit(0)` mid-flight; reopen outbox in a fresh process, verify head state and unacked tail. (2) Replay-against-restarted-receiver: sender is the same, receiver restarts; on next session the receiver's `MessageAckScheduler` sends an immediate ACK carrying its head, sender drops everything below head, retransmits the gap. |

### C.3 Fault injection & compatibility

| Case | Approach |
|---|---|
| Outbox file corruption | In unit test, write garbage bytes mid-file, reopen, assert the loader skips the bad line and warns (does not throw). Document the warning text. |
| ACK loss → infinite retransmit | Inject a `MessageAckScheduler` with `ackTimer` always returning `null`. After 5 retries, assert `outbox-abandoned` event fires with the abandoned `seq` set. |
| Receive window full | Push 257 unique seqs, assert the 1st is evicted, the 258th is `new`. |
| Pre-Stage-1 peer sends a message with no `seq` | Codec decodes to `seq: null`. Receiver treats as "in-order", assigns synthetic seq = `lastSeq + 1` internally without surfacing to the sender. Round-trip with the same legacy peer must not crash. |
| Concurrent sends while ACK is in flight | Two `await peer.send(msg)` interleaved; outbox order must match send-call order (Promise-chain serialization test). |

### C.4 Mocking discipline

- `werift`'s `RTCPeerConnection` is **not** mocked — the existing pattern (two real `PeerConnection`s on 127.0.0.1) is preserved. Per AGENTS.md, integration tests are slow by design.
- `OutboxStore` is tested against a temp `mkdtemp` directory; never touches `~/.wenchat`.
- `ReceiveWindow` and `MessageAckScheduler` are pure logic — no IO, no clock (clock injected via `now: () => number` for the timer tests).
- The `Transport.ts` decode path uses the existing `decodeWirePacket` and adds no new IO surface.

### C.5 Coverage floor

Code paths that MUST have a test:
- Every public method of `OutboxStore`, `MessageAckScheduler`, `ReceiveWindow`.
- The 6 transition edges in `peer.ts` where `seq` flows: enqueue → outbox → wire → receive window → delivered; enqueue → outbox → ack → drop; send fails → retransmit; etc.
- Both ack types (`message-ack`, `file-chunk-ack`) on both directions.

---

## D. PR Breakdown

Strict dependency ordering. Each PR is independently mergeable in that the full test suite stays green and no PR adds a feature flag — they are stacked but additive.

### PR-1: `feat(protocol): add seq envelope + MessageAck frame + FileChunkAck frame`

- **Scope:** `@wenchat/protocol`
- **Files:** `message.ts`, `codec.ts`, tests
- **Deps:** none
- **Risk:** zero — protocol package has zero runtime deps and no consumer yet.
- **New deps:** no
- **ADR:** links ADR 0001, sets up ADR 0003.

### PR-2: `feat(core): persistent per-peer outbox (JSONL)`

- **Scope:** `@wenchat/core`
- **Files:** NEW `outbox.ts`, extend `index.ts`, NEW `tests/unit/outbox.test.ts`, `docs/devops/core.md` ("Outbox on disk" section).
- **Deps:** PR-1 (optional — outbox works without `seq`, just stores opaque payloads).
- **Risk:** outbox IO on every send; unit test coverage must hit the partial-write recovery path.
- **New deps:** no (uses `node:fs/promises`).
- **Key invariant:** write-fsync is per-append, not per-batch. Yes, this is slow; no, we do not batch across sends.

### PR-3: `feat(core): MessageAckScheduler + per-peer seq assignment + outbox wiring`

- **Scope:** `@wenchat/core`
- **Files:** NEW `messageAck.ts`, modify `peer.ts`, `transport.ts`, `session.ts`, `index.ts`; NEW `tests/unit/messageAck.test.ts`; NEW `tests/integration/reliability.test.ts` (initial cases — two peers exchange 50 messages, outbox drains).
- **Deps:** PR-1, PR-2.
- **Risk:** high — touches the hot path of every send and every inbound message. Mitigation: keep `MessageAckScheduler` small and pure (no IO), inject it into `PeerConnection` so it can be replaced with a fake in tests.
- **New deps:** no.
- **Decision gate:** if Q3 timer choice is "200 ms", PR-3 lands with that. If user wants something else, that's a one-line change in `MessageAckScheduler.start()`.

### PR-4: `feat(core): receive window + dedup + gap detection`

- **Scope:** `@wenchat/core`
- **Files:** NEW `receiveWindow.ts`, modify `transport.ts`, `session.ts`; NEW `tests/unit/receiveWindow.test.ts`; extend `tests/integration/reliability.test.ts` (gap detection, duplicate injection).
- **Deps:** PR-3.
- **Risk:** medium — the receive window sits in the inbound decode path; must not double-fire messages.
- **New deps:** no.

### PR-5: `feat(core): file transfer chunk-level ACK + selective retransmit`

- **Scope:** `@wenchat/core`
- **Files:** modify `fileTransfer.ts`; extend `tests/integration/fileTransfer.test.ts` (mid-transfer reconnect, selective retransmit); extend `tests/unit/fileTransfer.test.ts` (bitmap ACK round-trip).
- **Deps:** PR-3, PR-4.
- **Risk:** high — see B.2 note on `out-of-order chunk` reframing. **Key decision lock needed before merge:** the "out-of-order chunk = protocol violation" rule must be softened to "out-of-order chunk = request retransmit unless bitmap says it's a permanent gap (i.e. the sender abandoned the transfer)". Document this in code comments and the integration test names.
- **New deps:** no.

### PR-6: `chore(core,cli): docs, integration hardening, end-to-end run`

- **Scope:** `@wenchat/core`, `@wenchat/cli`, docs
- **Files:** `apps/cli/src/connectionMachine.ts` (add `outbox-abandoned` effect), `apps/cli/src/App.tsx` (subscribe), `docs/devops/core.md` (extend), `docs/adr/0003-stage-1-wire-format.md` (NEW), `CHANGELOG.md`, `release-notes/v0.2.0.md` (draft), `CONTEXT.md` (verify Stage-1 terms).
- **Deps:** PR-1 through PR-5.
- **Risk:** low.
- **New deps:** no.

**Why not split differently?** PR-3 and PR-4 could be merged but they have different test surfaces (sender-side IO vs receiver-side state) and a clean diff between them makes review tractable. PR-5 deliberately waits until PR-3 and PR-4 are landed so the chunk-level ACK can reuse the same scheduler primitives.

---

## E. Doc Sync Checklist

| Doc | Required change | PR |
|---|---|---|
| `AGENTS.md` | No structural change. The new components (`outbox.ts`, `messageAck.ts`, `receiveWindow.ts`) live in `packages/core/src/` which is already covered. Add a one-liner under "Project" → "Monorepo layout" if a reader needs to know which file owns which reliability primitive. Optional. | PR-6 |
| `CONTEXT.md` | Stage 1 terms (`seq`, `ACK`, `outbox`, `receive window`) are already present per the snapshot. **Verify nothing has drifted during implementation.** If implementation introduces new terms (e.g. `chunk-ack-bitmap`, `outbox-head-tombstone`), add them. | PR-6 |
| `docs/adr/0001-…` | No change — already locked. | — |
| `docs/adr/0002-…` | No change — Stage 2 deferred. | — |
| `docs/adr/0003-stage-1-wire-format.md` (NEW) | Locks the resolutions to A.2 questions. Treat as the implementation contract. | PR-6 (or split: a `docs: …` PR right after PR-3 settles the open questions, before PR-5 needs them) |
| `docs/devops/core.md` | New section "Outbox on disk" (path, format, crash recovery, fsync policy); new section "Receive window across `swapSession`"; new section "Chunk-level ACK semantics". | PR-2 (outbox), PR-4 (window), PR-5 (chunk ACK) |
| `docs/devops/cli.md` | If Q12 = "yes", one paragraph: `outbox-abandoned` surfaces as a chat-log line. Else no change. | PR-6 |
| `CHANGELOG.md` | `[Unreleased]` entry: "Stage 1 application-layer message reliability" with bullet per PR. | PR-6 |
| `release-notes/vX.Y.Z.md` (draft) | User-facing summary of what changes for end users: messages no longer lost on reconnect, file transfers resume after mid-transfer drops, no breaking changes for LAN chat between two Stage-1 builds. | PR-6 |

---

## F. Risks & Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| F.1 | Outbox `fsync` per-append stalls on slow disks (HDD, network mounts). | Medium | High — every send blocks. | Cap with an in-memory bounded queue (max 16 unflushed entries) and a background flusher. The cap is the recovery window for a hard kill. Document the trade-off in `core.md`. |
| F.2 | ACK loss → infinite retransmit of an outbox entry. | Medium | Medium — bandwidth, plus UI noise. | Per Q4: 5 retries with exponential backoff (2 s, 4 s, 8 s, 16 s, 30 s). On give-up, emit `outbox-abandoned` and surface as a system message (per Q12). |
| F.3 | Receive window overflow during a long reconnect → silent loss of dedup state. | Low | Medium | LRU cap at 256 (Q7); on eviction, the next inbound seq triggers a "gap" → immediate ACK → retransmit covers the gap. The loss is recoverable, not silent. |
| F.4 | Backpressure: receive window full means the sender's outbox grows unbounded. | Low | High — disk + memory. | Tied to F.2: the ACK feedback loop means the sender pauses on receive-window-full via the existing `BUFFERED_AMOUNT_HIGH_WATER` if SCTP queue is also full. In practice, the receive window is at the application layer (after decode), so SCTP backpressure is the first gate. Document: outbox growth is bounded by SCTP's own retransmit buffer + heartbeat (4 s kill). |
| F.5 | Chunk-level ACK + outbox persistence boundary: should a chunk that fails to land be re-sent through the outbox? | Open | Medium | Recommended: **No**. File chunks are not in the outbox. The chunk-level ACK bitmap is the recovery channel; the outbox only covers application messages. Rationale: chunks are bulk data; persisting them would double disk usage. The bitmap ACK lives only in memory on both sides for the duration of the transfer. On sender crash mid-transfer, the receiver's `file-end` never lands; the receiver times out the partial `*.part` file (existing cleanup path). On reconnect mid-transfer, the sender treats it as a fresh transfer (existing behaviour — `transferId` changes). **Lock this in PR-5.** |
| F.6 | Cross-`swapSession` ordering: old Session's unacked messages vs new Session's new messages. | Medium | Medium — could appear as out-of-order delivery. | Per Q10: preserve the seq counter. New messages take the next seq after the last unacked one. Receiver sees a single monotonic sequence — no risk of "old Session msg X arriving after new Session msg Y" reading as reordering, because both have strictly increasing `seq`. |
| F.7 | Test coverage floor: < 80% on any new module. | Low | Low — process gate. | CI gate: `bun test --coverage` threshold 80%. The test matrix in section C is sized to clear this comfortably; `outbox.ts` and `messageAck.ts` have unit tests for every branch, `receiveWindow.ts` is small enough to fully cover with 4 cases. |
| F.8 | Werift `RTCPeerConnection` mock would speed tests but introduce drift. | Low | Low | Decision: **do not mock.** Follow AGENTS.md guidance. Integration tests budget ~30 s each, integration suite total stays under 5 min on CI. |
| F.9 | Disk full / permission denied writing outbox → silent message loss. | Medium | High | `OutboxStore.append` MUST throw on ENOSPC / EACCES. Caller (`peer.ts::send`) catches and re-throws as a `SendError` to the app. App surfaces as system message ("Failed to send: outbox unwritable"). On startup, if the head tombstone cannot be read, refuse to load the outbox (don't silently reset seq — that would allow replay attacks). |

---

## G. Explicitly Out of Scope (per ADR 0001 + 0002)

- No QUIC. No native binding. No `@number0/iroh`, no `@matrixai/quic`. No change to `signaling.ts` beyond what ADR 0001's consequences require.
- No multi-peer. No mesh. No peer-to-peer ACK matrix. 1-to-1 only, same as today.
- No TUI redesign. `apps/cli/src/ChatView.tsx`, `Header.tsx`, `PeerList.tsx`, etc. are not touched unless Q12 = "yes" (and even then, the change is one `appendSystemMessage` call in `App.tsx`, not a new component).
- No `@yao-pkg/pkg` script changes. The packed binary matrix stays linux-x64 / darwin-arm64 / windows-x64.
- No signaling HTTP additions. `/offer`, `/candidate`, `/bye`, `/health` remain the only endpoints. ACK travels over the DataChannel, not over HTTP.
- No CLI subcommand additions (no `/outbox`, no `/retransmit`). Outbox state is internal.
- No header/metadata changes to file chunks (`encodeFileChunkFrame` stays 22-byte header). Chunk identity is `transferId + index` already; bitmap ACK references both.
- No protocol versioning. Backward compatibility is handled by the `seq: null` default for legacy messages (Q11). If a future breaking change is needed, that's when we add a version byte.

---

## Open Questions — for you to confirm before PR-1

1. **Q1 seq width:** confirm `u64` (ADR 0001 default) or push back to `u32`?
2. **Q2 ACK shape:** confirm single-value `N` for app messages + bitmap per `transferId` for chunks?
3. **Q3 ACK trigger cadence:** confirm the 200 ms idle + every-16 hybrid?
4. **Q4 Retransmit policy:** confirm 5 retries, 2 s → 30 s exponential, give-up emits `outbox-abandoned`?
5. **Q5 Outbox format:** confirm JSONL (already in CONTEXT.md)?
6. **Q6 Outbox truncation:** confirm soft tombstone + background compaction when outbox > 1 MiB?
7. **Q7 Receive window size:** confirm 256-entry LRU cap?
8. **Q8 Chunk-level ACK granularity:** confirm every-32-chunk + on `file-end`?
9. **Q9 Heartbeat vs ACK scheduler:** confirm they coexist (ADR 0001 says yes)?
10. **Q10 Cross-`swapSession` continuity:** confirm `seq` counter persists in the outbox header across reconnect?
11. **Q11 Backward compatibility:** confirm `seq: null` on legacy frames, no version byte?
12. **Q12 UI:** confirm `outbox-abandoned` surfaces as a chat-log line via `appendSystemMessage`, no TUI work?
13. **F.5 chunk/outbox boundary:** confirm chunks do NOT go through the outbox (bitmap ACK is the only recovery channel)?
14. **ADR 0003:** confirm I should draft it as the implementation contract, or do you prefer to lock each open question inline in PR descriptions?

Once you sign off (especially on Q1–Q6 and F.5), PR-1 can land without further architectural decisions.

---

## Critical Files for Implementation

- /Users/wenchen/workspace/github/wenchat/packages/protocol/src/message.ts
- /Users/wenchen/workspace/github/wenchat/packages/core/src/peer.ts
- /Users/wenchen/workspace/github/wenchat/packages/core/src/transport.ts
- /Users/wenchen/workspace/github/wenchat/packages/core/src/fileTransfer.ts
- /Users/wenchen/workspace/github/wenchat/packages/core/src/session.ts

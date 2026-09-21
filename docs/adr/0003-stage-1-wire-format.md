# Stage 1 wire format and operational contract

Locks the open questions from `docs/devops/stage-1-implementation-plan.md` §A.2 (and §F.5) so each Stage-1 implementation PR can land without re-litigating them. Choices favor the smallest blast radius: a single monotonic `seq` per peer, a single-value `MessageAck`, a bitmap `FileChunkAckMessage` per transfer, a JSONL outbox with soft tombstones and bounded compaction, an LRU receive window of 256 entries, and a hybrid ACK cadence (200 ms idle + every 16 messages). File chunks do not flow through the outbox — bitmap ACK is the only recovery channel — because chunks are bulk data whose volume would otherwise double disk usage without adding semantic value over the existing sha256 + atomic-rename path.

## Status

accepted (2026-09-19)

## Resolutions

These lock `stage-1-implementation-plan.md` §A.2 + §F.5. Each row is the implementation contract.

| # | Decision |
|---|---|
| Q1 | `seq` is `u64` (per-peer, monotonically increasing; survives reconnect via outbox header). |
| Q2 | Application messages use single-value `MessageAckMessage { ack: N }` (highest contiguous seq received). File chunks use `FileChunkAckMessage { transferId, bitmap, lastIndex }` per transfer. The two are separate frame types. |
| Q3 | Outbound `MessageAck` fires on whichever happens first: 200 ms idle timer, every 16 inbound messages, or session close. |
| Q4 | Per-message retransmit: initial 2 s, exponential ×2 capped at 30 s, give up after 5 retries → emit `outbox-abandoned`. |
| Q5 | Outbox format is JSONL, append-friendly, one record per line. |
| Q6 | Outbox truncation is a soft tombstone `{ kind: "ack", seq: N }`. Background compactor rewrites the file when `outbox > 1 MiB AND head < tail − 1 KiB`. |
| Q7 | `ReceiveWindow` is a 256-entry LRU `Set<number>`. On eviction the next inbound seq triggers a gap → immediate ACK → retransmit covers the gap (loss is recoverable, not silent). |
| Q8 | `FileChunkAckMessage` fires every 32 chunks AND on `file-end`. |
| Q9 | `HeartbeatScheduler` and `MessageAckScheduler` are independent, co-located in `peer.ts`. |
| Q10 | `seq` counter persists in outbox header `{ kind: "head", head: N }`. Receiver-side state may be in-memory across `swapSession`, but resyncs via the outbox replay on next session. |
| Q11 | Legacy frames with no `seq` decode to `seq: null`. No protocol version byte. |
| Q12 | TUI does not render ACK/outbox progress. `outbox-abandoned` surfaces as a system message via the existing `appendSystemMessage` path. |
| F.5 | File chunks do **not** flow through the outbox. Bitmap ACK is the only recovery channel. Sender crash mid-transfer → receiver times out `*.part`. Reconnect mid-transfer → fresh transfer with new `transferId`. |
| Q14 | This ADR (0003) is the implementation contract; PRs reference it by number. |

## Considered Options

- **Chosen — locked defaults from §A.2.** Each was annotated with rationale in the plan; rationale is not repeated here.
- **Rejected — protocol version byte.** Q11 considered adding a version byte for explicit feature negotiation. Rejected because the additive `seq: null` field fully covers backward compatibility, and a version byte would force every future change to bump it. Reserved for the day a true breaking change is needed.

## Amendments

- **2026-09-21 — chunk retransmit initial delay 200 ms → 2 s; heartbeat watchdog semantics.** Production incident: after a file transfer completed, the connection died within seconds ("Lost connection … Reconnecting … Failed to connect"). Reproduced on a lossy LAN: `FileSender`'s 200 ms retransmit stacked duplicate bulk traffic onto SCTP's own congestion recovery (sender queue froze at ~4.7 k chunks, association wedged), and the 4 s heartbeat watchdog — re-armed only by ping/pong — fired while file/ACK traffic was still flowing. Amendments (operational parameters only; wire format unchanged): `FILE_INITIAL_RETRANSMIT_MS = 2 s` (SCTP owns fast loss recovery; the app layer owns "SCTP made no progress for a long time"); heartbeat watchdog is re-armed by ANY inbound frame and fires after 15 s of total silence; pings are suppressed while other traffic has been seen within the interval. See `CONTEXT.md` "Heartbeat" and `docs/devops/core.md` "Sender-side retransmit policy".

## Consequences

- Implementation PRs reference this ADR by number; deviations require an ADR amendment.
- Q1, Q2, Q5, Q6, Q11 touch wire format — any change to them is a breaking change for already-shipped Stage-1 clients and requires a new ADR.
- F.5 means the outbox file size is bounded by chat traffic, not file transfer traffic. Document this in `docs/devops/core.md` so operators do not worry about disk growth from file transfers.
- Q12 means the CLI's TUI is not a reliability observability surface. Future work to expose per-message ACK state in the UI requires a new ADR.
- The companion implementation plan lives at `docs/devops/stage-1-implementation-plan.md`. This ADR is the contract; the plan is the work breakdown.

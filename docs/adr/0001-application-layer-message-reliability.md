# Per-peer application-layer message reliability

WenChat needs end-to-end message continuity across reconnects and process restarts, which the current `werift` WebRTC DataChannel does not provide — its SCTP-level reliability is byte-stream only and resets on every new SCTP association. We add a per-peer monotonic `seq`, receiver ACK, and persistent outbox at the application layer instead of swapping the transport for QUIC, because the npm QUIC ecosystem is not yet mature enough to replace WebRTC for the LAN job, and Stage 2 (cross-network reach) is the right time to revisit the transport decision.

## Status

accepted (2026-09-19)

## Considered Options

- **C (chosen) — per-peer `seq` + ACK + persistent outbox + chunk-level ACK for file transfer.**
  Resolves message continuity with the smallest blast radius. The wire format stays transport-agnostic, so Stage 2 can swap DataChannel for QUIC without breaking the application protocol.
- **A — status quo, rely on SCTP reliability.** Insufficient: a fresh SCTP association after reconnect has fresh numbering, so in-flight messages are lost with no way to detect or recover them.
- **B — application-layer `seq` + ACK without persistence.** Loses unacknowledged messages on process crash or hard kill.
- **D — C plus reliable broadcast for multi-peer.** The strict 1-to-1 model makes a peer-to-peer ACK matrix a zero-value addition today.
- **E (deferred to Stage 2) — replace transport with QUIC.** `quico` (the only actively-maintained pure-JS option) ships without 0-RTT, connection migration, Retry, or ECN. Native-binding options (`@matrixai/quic`, `@number0/iroh`) carry known `@yao-pkg/pkg` N-API registration hazards (#275) and platform coverage gaps. Node 20's built-in QUIC API is not yet stable. Re-evaluate in Stage 2 when cross-network reach makes the trade-off worthwhile.

## Consequences

- New per-peer `seq` (u64) and a `MessageAck` frame type land in `packages/protocol`.
- Outbox persisted at `~/.wenchat/<localId>/outbox/<peerId>.jsonl`; ordering invariant = `seq`.
- A new `MessageAckScheduler` runs alongside the existing `HeartbeatScheduler`; both coexist during the transition window.
- File transfer gains chunk-level ACK and selective retransmit on top of the existing 64 KiB frame split (`fileTransfer.ts`).
- Test surface expands: crash/restart simulation, mid-transfer reconnect, duplicate injection, outbox replay.
- The wire format must remain transport-agnostic so Stage 2 does not require a breaking change to existing outbox files.

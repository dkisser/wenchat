# Cross-network transport evaluation (QUIC)

Stage 2 trigger: when WenChat needs to reach peers across L3 boundaries reachable only via a user-managed L3 overlay (ZeroTier, Tailscale, or any routed VPN), evaluate replacing or supplementing the WebRTC DataChannel transport with QUIC. Out of scope until triggered — no implementation work before then.

## Status

proposed (placeholder; full evaluation deferred to Stage 2 kickoff)

## Trigger conditions

- At least one confirmed user need that LAN discovery cannot satisfy.
- A deployment story for the overlay network is chosen (default proposal: user-managed ZeroTier / Tailscale — no STUN/TURN relay operated by the project).
- The cross-network authentication story (TOFU + pairing code from the glossary) is implemented and stable.

## Evaluation dimensions

To be filled in at Stage 2 kickoff. Initial axes:

1. **npm QUIC library candidates.** Re-check `quico` for filled feature gaps; evaluate `@matrixai/quic`, `@infisical/quic`, and `@number0/iroh` against the current `@yao-pkg/pkg` packaging matrix (linux-x64, darwin-arm64, windows-x64).
2. **Signaling simplification.** Can a QUIC endpoint absorb the in-process HTTP signaling server, or do they remain separate surfaces?
3. **Cross-platform matrix.** linux-x64, darwin-arm64, windows-x64 must stay green with no increase in build complexity.
4. **Migration shape.** Parallel-run (add QUIC alongside DataChannel, feature-flag) versus hard cut.
5. **Interaction with Stage 1.** Whether the application-layer `seq` / ACK / outbox introduced in ADR 0001 is retired (relying on QUIC stream + connection semantics), kept as defense-in-depth, or repurposed.

## Consequences

- No implementation work before the trigger conditions are met.
- Stage 1 decisions (`seq` numbering, `MessageAck` frame shape, outbox layout) must remain compatible with both WebRTC DataChannel and QUIC so a future migration is not a hard cut for already-shipped clients.

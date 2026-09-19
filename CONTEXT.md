# WenChat Domain Glossary

WenChat is a LAN-first, peer-to-peer terminal chat tool (`werift` WebRTC DataChannel + mDNS discovery + in-process HTTP signaling). This glossary fixes the project-specific terms used in the codebase and design discussions so that vocabulary does not drift across sessions.

## Transmission

**PeerConnection**:
The wrapper object in `@wenchat/core` (`packages/core/src/peer.ts`) that owns one `RTCPeerConnection`, one SCTP association, and one DataChannel for a single peer.
_Avoid_: Connection, link, transport

**Session**:
One ICE + DTLS + SCTP establishment cycle wrapped by `PeerConnection`. Reconnect creates a new `Session` and `swapSession()` replaces the previous one.
_Avoid_: PeerSession, RTCSession

**DataChannel**:
The werift `RTCDataChannel` named `"wenchat"`. Default `ordered: true`, `maxRetransmits: null` — a reliable, ordered SCTP stream.
_Avoid_: Channel, pipe

**Heartbeat**:
Application-layer keepalive ping sent every 2s with a 4s timeout (`packages/core/src/heartbeat.ts`). Detects dead links independently of SCTP-level signals.
_Avoid_: Ping, keepalive

**Host candidate**:
A local NIC IP exposed as an ICE candidate. With `iceServers: []`, host candidates are the only candidate type WenChat produces; there is no STUN-derived `srflx` and no TURN `relay`.
_Avoid_: Local address, direct IP

## Discovery

**Bonjour instance**:
The mDNS service published by `bonjour-service` as `_wenchat._tcp.local`. Instance name is `<displayName>-<localId6hex>`; TXT record carries `id`, `displayName`, `signalingHost`, `signalingPort`.
_Avoid_: mDNS record, service

**localId**:
A 12-hex-character identifier persisted in `~/.wenchat/local-id`. Stabilizes the Bonjour instance name across restarts so macOS mDNSResponder does not rename the system hostname.
_Avoid_: Device ID, node ID

**SignalingServer**:
The in-process `node:http` server in `packages/core/src/signaling.ts` that carries SDP, ICE candidates, and `/bye` control messages between two peers over TCP.
_Avoid_: HTTP server, control plane

## Reliability (Stage 1, ADR 0001)

**seq (per-peer sequence)**:
A monotonically increasing 64-bit unsigned integer assigned by the sender for each peer. Decouples transport-level reliability (SCTP) from application-level message identity that must survive reconnects.
_Avoid_: message ID, packet number

**ACK**:
A frame sent by the receiver declaring "I have received all messages with `seq <= N`". Triggers the sender to discard confirmed messages from the outbox and to retransmit unacknowledged ones.
_Avoid_: acknowledgment, confirm

**outbox**:
The sender-side persistent queue of unacknowledged messages, written to `~/.wenchat/<localId>/outbox/<peerId>.jsonl`. Survives process restart and reconnect.
_Avoid_: Send queue, mailbox

**receive window**:
The receiver-side sliding window that deduplicates by `seq` and detects gaps. The window size bounds how far ahead of the highest contiguous `seq` a peer may send.
_Avoid_: dedup buffer, reorder buffer

## Cross-Network Trust (Stage 2)

**TOFU**:
Trust On First Use. The first connection between two peers exchanges a self-signed identity fingerprint; the user verifies the fingerprint out of band; subsequent connections accept the same fingerprint without re-prompting.
_Avoid_: First-trust, fingerprint pinning

**pairing code**:
A short alphanumeric code displayed on both ends during first connection. The user compares the codes out of band to authorize the TOFU fingerprint exchange.
_Avoid_: Pair code, OTP, verification code

**VPN peer**:
A peer reachable via a user-managed L3 overlay (ZeroTier, Tailscale, or any routed VPN). At the transport layer WenChat treats it identically to a LAN peer.
_Avoid_: Remote peer, overlay peer

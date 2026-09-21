# Known issues

Diagnosed-but-unfixed defects and upstream limitations. Each entry carries
the observed symptom, the trigger/mechanism, a log signature where one
exists, and the fix direction. Remove an entry when its fix lands; file
new entries here as soon as a defect is reproducible.

## 1. Reconnect glare kills both sessions, and both sides give up

**Symptom.** After a transport-level close that both sides detect at nearly
the same time, both UIs print `Failed to connect to <peer>` and land in
Offline; auto-retry stops for good even though both processes are alive.

**Trigger.** Both peers run the same probe → 1 s backoff → redial sequence
(`RECONNECT_BACKOFF_MS` is one shared constant, and on a fast LAN the HTTP
probe completes in a few ms), so the two redials are in flight within
milliseconds of each other. Each side accepts the other's offer while its
own dial is still open:

1. A dials B (session A₁) and B dials A (session B₁) at the same time.
2. A accepts B's offer → `PeerConnection.swapSession` installs the accepted
   session and closes A₁ (peer.ts, `swapSession` step 2). B does the mirror
   image, closing B₁.
3. A₁ and B₁ are ends of **two different** connections, so each local close
   kills the *other* side's accepted session. Both connections die.

**Log signature** (from a real incident, 2026-09-21): two
`connection state: connecting` events ~16 ms apart, then within ~1 ms two
`connection terminated, reason "network"` events plus a `data channel
closed`.

**State-machine amplifier.** The incoming offer moves the phase to
`dialing` before the accepted session dies, so the terminal event is
handled by the `dialing` branch of `handleWire` (connectionMachine.ts),
which prints "Failed to connect to X" and goes straight to idle with no
retry scheduled. Retrying from the state machine alone is NOT a fix: both
sides would redial together and re-collide every backoff round.

**Fix direction.** Transport-level tie-break so exactly one connection
survives: compare the two endpoints' `signalingHost:signalingPort`
lexicographically — e.g. the lexicographically larger side keeps its
INITIATED session and releases the accepted one; the smaller side keeps
the ACCEPTED session and cancels its dial. Both sides then retain the same
single connection. Add a state-machine fallback that keeps walking the
backoff table when a retry-phase dial dies.

**Status.** Not started. Severity: high for genuine network partitions;
masked in the common file-transfer scenario by the d7405da watchdog fix.

## 2. `dist-release/` binaries predate the d7405da watchdog fix

The packaged binaries in `dist-release/` (and any GitHub Release assets cut
before d7405da) still carry the old 4 s watchdog + 200 ms chunk retransmit.
Anyone running a packaged build needs a rebuild (`bun run package:cli`) or
a fresh release to pick up the fix.

## 3. werift-sctp: T3 timer never starts while the send queue is frozen

Diagnosed during the d7405da investigation (incident preserved in
`logs/wenchat-2026-09-21.log`). Under heavy congestion the association can
reach a state where `flight == cwnd`, `t3` is false, and thousands of
chunks sit in `sentQ`/`outQ` with no timer armed to retransmit the queue
head — the association freezes until the application layer gives up.

The 2 s `FILE_INITIAL_RETRANSMIT_MS` + 15 s watchdog combination from
d7405da works around it from above; a proper fix needs an upstream werift
patch. If a future upgrade touches werift, or a similar freeze reappears
(send queue large, no timer armed), start here.

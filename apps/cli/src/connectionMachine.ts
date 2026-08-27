import type { ConnectionEvent } from "@wenchat/core";
import { isRetryable } from "@wenchat/core";
import type { PeerInfo } from "@wenchat/protocol";
import type { StatusBarStatus } from "@wenchat/ui";

/**
 * The connection state machine, as a pure function.
 *
 * This exists because the reconnect logic used to live in four mutable refs
 * (`lastPeer`, `reconnectAttempt`, `reconnectTimer`, `connectionGeneration`)
 * whose reset combination — cancel the timer, zero the attempt, bump the
 * generation — was copy-pasted across six handlers. Any handler that forgot
 * one of the three was a bug, and the biggest one was structural: the
 * terminal-state branch had no way to tell an intentional teardown from a
 * network drop, so it auto-redialed a peer who had just typed `/exit`.
 *
 * Now every transition is one `reduce` call away from being read off the
 * table below, and the retry decision has exactly one gate: `isRetryable`.
 * Side effects are returned as data for the caller to execute, which keeps
 * this file free of React, timers, and WebRTC.
 */

// First slot is short ("Wi-Fi blip" — most transients recover inside ~1 s);
// the trailing 10 s slots carry the "they're really gone" stretch. Five
// attempts × ~28 s of wall-clock buys enough time to ride out an
// access-point roam without stranding the user staring at a spinner.
export const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000, 10000] as const;
export const MAX_RECONNECT_ATTEMPTS = RECONNECT_BACKOFF_MS.length;

export type ConnectionPhase =
	| { readonly kind: "idle" }
	/** A handshake is in flight — either we dialed, or a peer dialed us. */
	| { readonly kind: "dialing"; readonly peer: PeerInfo }
	| { readonly kind: "online"; readonly peer: PeerInfo }
	/**
	 * A network-driven close is being retried. `attempt` is 1-based and
	 * indexes {@link RECONNECT_BACKOFF_MS}. The phase covers both "waiting
	 * for the timer" and "the retry dial is in flight" — the counter is what
	 * distinguishes rounds, not a separate state.
	 */
	| { readonly kind: "retrying"; readonly peer: PeerInfo; readonly attempt: number };

export type MachineEvent =
	/** User picked a peer, ran `/connect`, or ran `/reconnect` while idle. */
	| { readonly kind: "dial"; readonly peer: PeerInfo }
	/**
	 * User ran `/reconnect` while a retry was armed: same intent as
	 * "the backoff timer elapsed" but fires now instead of waiting.
	 * No-op (with feedback) outside a `retrying` phase — the command has
	 * nothing to skip past.
	 */
	| { readonly kind: "retry-now" }
	/** A peer is dialing us (signaling `/offer` arrived). */
	| { readonly kind: "incoming"; readonly peer: PeerInfo }
	/** A `connect()` call rejected. */
	| { readonly kind: "dial-failed" }
	/** The backoff timer elapsed. */
	| { readonly kind: "retry-fired" }
	/** A connection state event arrived from `@wenchat/core`. */
	| { readonly kind: "wire"; readonly event: ConnectionEvent }
	| { readonly kind: "user-disconnect" }
	| { readonly kind: "user-exit" }
	| { readonly kind: "user-cancel" };

export type Effect =
	| { readonly kind: "cancel-retry" }
	| { readonly kind: "schedule-retry"; readonly delayMs: number }
	| { readonly kind: "dial"; readonly peer: PeerInfo }
	/** Free the dead session's UDP/STUN resources before the next dial. */
	| { readonly kind: "close-active-session" }
	/** Send a `bye`, let it flush, then tear the session down. */
	| { readonly kind: "close-graceful"; readonly reason: "local-exit" | "local-disconnect" }
	/**
	 * Invalidate in-flight `connect()` awaits so a late resolve cannot
	 * re-install a session under a newer user action. Implemented by the
	 * caller as a monotonic generation bump — the mechanism is imperative,
	 * but *when* it happens belongs in the table.
	 */
	| { readonly kind: "invalidate-dials" }
	/** Any in-flight inbound transfer is now hopeless; clean up temp files. */
	| { readonly kind: "dispose-transfers" }
	| { readonly kind: "system-message"; readonly text: string };

export type Transition = {
	readonly phase: ConnectionPhase;
	readonly effects: readonly Effect[];
};

export const IDLE_PHASE: ConnectionPhase = { kind: "idle" };

/** The peer this phase is about, if any. Drives the status bar's name. */
export function phasePeer(phase: ConnectionPhase): PeerInfo | null {
	return phase.kind === "idle" ? null : phase.peer;
}

export function toStatusBarStatus(phase: ConnectionPhase): StatusBarStatus {
	switch (phase.kind) {
		case "idle":
			return "offline";
		case "dialing":
			return "connecting";
		case "online":
			return "online";
		case "retrying":
			return "reconnecting";
	}
}

/** A manually dialed peer has no mDNS display name — show its endpoint. */
export function peerLabel(peer: PeerInfo): string {
	return peer.id === "manual" ? peerEndpoint(peer) : peer.displayName;
}

export function peerEndpoint(peer: PeerInfo): string {
	return `${peer.signalingHost}:${peer.signalingPort}`;
}

/** "alice (192.168.1.10:4242)", or just the endpoint for a manual dial. */
export function describePeer(peer: PeerInfo): string {
	return peer.id === "manual" ? peerEndpoint(peer) : `${peer.displayName} (${peerEndpoint(peer)})`;
}

/**
 * What to tell the user about a REMOTE close we are NOT retrying.
 *
 * Only the two `remote-*` reasons reach this helper:
 *   - `local-*` notices are printed synchronously by their `user-*`
 *     handlers, so the wire event must not duplicate them.
 *   - `network` / `heartbeat-timeout` either retry (no message) or, in
 *     the dialing branch, get a purpose-specific "Failed to connect" line.
 *
 * Earlier revisions carried four unreachable `return null` cases to keep
 * the switch total; inlining the two real branches here is shorter and
 * the closed reason makes the callers' intent obvious.
 */
function farewellText(reason: "remote-exit" | "remote-disconnect", peer: PeerInfo): string {
	return reason === "remote-exit"
		? `${peerLabel(peer)} left the chat.`
		: `${peerLabel(peer)} disconnected.`;
}

/**
 * Enter (or advance) the retry phase for `attempt`. Gives up — back to idle
 * — once the backoff table is exhausted.
 */
function scheduleRetry(peer: PeerInfo, attempt: number, extra: readonly Effect[]): Transition {
	if (attempt > MAX_RECONNECT_ATTEMPTS) {
		const giveUpMsg = `Reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts.`;
		const giveUpHint = "Try /reconnect or pick another peer.";
		return {
			phase: IDLE_PHASE,
			effects: [...extra, { kind: "system-message", text: `${giveUpMsg} ${giveUpHint}` }],
		};
	}
	// `attempt` is bounded by the early-return above to `[1, MAX_RECONNECT_ATTEMPTS]`,
	// so the index is always in range — no `??` fallback needed (it was dead code).
	const delayMs = RECONNECT_BACKOFF_MS[attempt - 1];
	const seconds = Math.round(delayMs / 1000);
	const text =
		attempt === 1
			? `Lost connection to ${peerLabel(peer)}. Reconnecting in ${seconds}s…`
			: `Reconnect attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS} in ${seconds}s…`;
	return {
		phase: { kind: "retrying", peer, attempt },
		effects: [...extra, { kind: "system-message", text }, { kind: "schedule-retry", delayMs }],
	};
}

function stay(phase: ConnectionPhase, ...effects: readonly Effect[]): Transition {
	return { phase, effects };
}

function handleWire(phase: ConnectionPhase, event: ConnectionEvent): Transition {
	if (event.state !== "closed") {
		if (event.state === "connecting") {
			// Only meaningful while a handshake is in flight; `dialing` already
			// says that, and an `online`/`idle` phase has nothing to learn here.
			return stay(phase);
		}
		const peer = phasePeer(phase);
		// No peer means neither `dial` nor `incoming` ran — unreachable in
		// practice, and there is no identity to show, so stay put.
		if (!peer) return stay(phase);
		return {
			phase: { kind: "online", peer },
			effects: [
				{ kind: "cancel-retry" },
				{ kind: "system-message", text: `Connected to ${describePeer(peer)}` },
			],
		};
	}

	// Terminal. This branch is the whole point of the refactor: the reason
	// decides whether we redial, and every non-transport reason is final.
	const peer = phasePeer(phase);
	if (!peer) {
		return { phase: IDLE_PHASE, effects: [{ kind: "dispose-transfers" }] };
	}
	// A terminal event during a USER-INITIATED dial is still user-initiated:
	// do not auto-redial (the explicit contract from `dial-failed`).
	//
	// The message in this branch has to track `event.reason`:
	//   - retryable (`network`, `heartbeat-timeout`) → "Failed to connect to X".
	//     This is the user's signal that THEIR dial failed.
	//   - final (`local-*`, `remote-*`) → no message. The user action that
	//     started the final close already printed one (or, for `remote-*`,
	//     there is nothing to name — we never reached `connected`).
	//
	// Previously this branch hardcoded `farewellText("network", peer)`, which
	// silently suppressed the right wording AND printed "Failed to connect"
	// for `/disconnect` mid-handshake — a duplicate of the disconnect notice.
	if (phase.kind === "dialing") {
		const text = isRetryable(event.reason) ? `Failed to connect to ${describePeer(peer)}` : null;
		return {
			phase: IDLE_PHASE,
			effects: [
				{ kind: "dispose-transfers" },
				{ kind: "cancel-retry" },
				...(text ? ([{ kind: "system-message", text }] as const) : []),
			],
		};
	}
	if (isRetryable(event.reason)) {
		const attempt = phase.kind === "retrying" ? phase.attempt : 1;
		return scheduleRetry(peer, attempt, [{ kind: "dispose-transfers" }]);
	}
	// For LOCAL-* reasons the user-facing notice was already printed when
	// the user action fired (the `user-disconnect` handler prints the
	// disconnect notice synchronously; `user-exit` is handled in App.tsx
	// before teardown). Re-printing on the wire event would print the same
	// string twice. Only REMOTE reasons get a message here — those have no
	// opportunity to print earlier.
	if (event.reason === "remote-exit" || event.reason === "remote-disconnect") {
		return {
			phase: IDLE_PHASE,
			effects: [
				{ kind: "dispose-transfers" },
				{ kind: "cancel-retry" },
				{ kind: "system-message", text: farewellText(event.reason, peer) },
			],
		};
	}
	return {
		phase: IDLE_PHASE,
		effects: [{ kind: "dispose-transfers" }, { kind: "cancel-retry" }],
	};
}

export function reduce(phase: ConnectionPhase, event: MachineEvent): Transition {
	switch (event.kind) {
		case "dial": {
			// Dialing a new target while a session is live (or being retried)
			// would tear the live one down inside `connect()`. Make the user
			// say so explicitly instead of silently dropping their chat.
			if (phase.kind !== "idle") {
				return stay(phase, {
					kind: "system-message",
					text: "Already connected. Run /disconnect first to switch peer.",
				});
			}
			return {
				phase: { kind: "dialing", peer: event.peer },
				effects: [
					{ kind: "cancel-retry" },
					{ kind: "invalidate-dials" },
					{ kind: "dial", peer: event.peer },
				],
			};
		}

		case "incoming": {
			// Their offer wins over anything we had in flight: a manual dial
			// (running `connect()` for peer A) and a queued retry (timer
			// pending) both have to back down so the new session takes the
			// slot. `invalidate-dials` bumps the generation token; the losing
			// manual dial's late `connect()` then resolves stale and tears
			// ITS OWN session down (not whatever the swap installed).
			//
			// Older version only checked for `retrying` here, which let a
			// manual dial racing with an incoming offer leak both sessions.
			const hadInFlightDial = phase.kind === "retrying" || phase.kind === "dialing";
			return {
				phase: { kind: "dialing", peer: event.peer },
				effects: hadInFlightDial
					? [{ kind: "cancel-retry" }, { kind: "invalidate-dials" }]
					: [{ kind: "cancel-retry" }],
			};
		}

		case "dial-failed": {
			if (phase.kind === "retrying") {
				// Auto-retry: a failed dial is just this round failing.
				return scheduleRetry(phase.peer, phase.attempt + 1, []);
			}
			if (phase.kind === "dialing") {
				// User-initiated dials are NOT auto-retried — they need
				// predictable feedback, not a quiet retry storm.
				return {
					phase: IDLE_PHASE,
					effects: [
						{ kind: "system-message", text: `Failed to connect to ${describePeer(phase.peer)}` },
					],
				};
			}
			return stay(phase);
		}

		case "retry-fired": {
			if (phase.kind !== "retrying") return stay(phase);
			return stay(phase, { kind: "close-active-session" }, { kind: "dial", peer: phase.peer });
		}

		case "retry-now": {
			// `/reconnect` during a retry: same effect as the timer firing
			// now. Cancelling the timer here keeps the existing `setTimeout`
			// from firing the reducer a second time into the same slot.
			// Anything outside `retrying` has no timer to skip, so
			// surface feedback rather than starting a new daisy chain.
			if (phase.kind !== "retrying") {
				return stay(phase, {
					kind: "system-message",
					text: "No reconnect in progress.",
				});
			}
			return stay(
				phase,
				{ kind: "cancel-retry" },
				{ kind: "close-active-session" },
				{ kind: "dial", peer: phase.peer },
			);
		}

		case "wire":
			return handleWire(phase, event.event);

		case "user-disconnect": {
			if (phase.kind === "idle") {
				return stay(phase, { kind: "system-message", text: "Not connected" });
			}
			// Non-null safe: the early-return above already covered idle.
			const peer = phasePeer(phase);
			if (!peer) return stay(phase);
			// Print the disconnect notice HERE rather than waiting for the
			// terminal event to round-trip the same string back: `close-
			// graceful` sends a `bye`, waits up to 400ms for it to drain, and
			// only then closes the pc. The terminal event arrives after that
			// — too late for chat-log responsiveness. Phase is left unchanged
			// so the resulting wire event is the single source of truth for
			// the transition itself.
			return stay(
				phase,
				{ kind: "cancel-retry" },
				{ kind: "invalidate-dials" },
				{ kind: "close-graceful", reason: "local-disconnect" },
				{ kind: "system-message", text: `Disconnected from ${describePeer(peer)}` },
			);
		}

		case "user-exit": {
			// Idle path: nothing was connected; the chat log doesn't need a
			// bookkeeping entry. We still emit `cancel-retry` defensively so
			// a freshly-armed timer can't fire into a process that's about
			// to die.
			if (phase.kind === "idle") {
				return stay(phase, { kind: "cancel-retry" });
			}
			// Non-null safe: covered by the early-return above.
			const peer = phasePeer(phase);
			if (!peer) return stay(phase);
			// Surface the disconnect notice synchronously — same UX detail as
			// user-disconnect: the user is staring at a terminal about to
			// close, and `/exit` may not give `closeGracefully` its 400ms to
			// complete the bye drain before Ink unmounts.
			const text =
				phase.kind === "retrying"
					? `Reconnect cancelled. Disconnected from ${describePeer(peer)}`
					: `Disconnected from ${describePeer(peer)}`;
			return stay(
				phase,
				{ kind: "cancel-retry" },
				{ kind: "invalidate-dials" },
				{ kind: "dispose-transfers" },
				{ kind: "close-graceful", reason: "local-exit" },
				{ kind: "system-message", text },
			);
		}

		case "user-cancel": {
			if (phase.kind !== "retrying") {
				return stay(phase, { kind: "system-message", text: "No reconnect in progress." });
			}
			// Back to idle but the caller keeps its "last peer" memory, so
			// `/reconnect` still works after a cancel.
			return {
				phase: IDLE_PHASE,
				effects: [
					{ kind: "cancel-retry" },
					{ kind: "invalidate-dials" },
					{ kind: "system-message", text: "Reconnect cancelled." },
				],
			};
		}
	}
}

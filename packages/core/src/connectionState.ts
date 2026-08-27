import type { ByeReason } from "@wenchat/protocol";

/**
 * Why a session ended.
 *
 * This is the field the whole reconnect story hangs off. WebRTC only tells
 * us *that* a connection died, never *why* — so before this existed the app
 * had to treat every terminal event as a network blip and auto-redial, even
 * when the peer had just typed `/exit`. The reason travels with the terminal
 * event from here up to the CLI's state machine, which uses
 * {@link isRetryable} as the single decision point.
 */
export type CloseReason =
	/** pc went `disconnected`/`failed`, or the data channel died on its own. */
	| "network"
	/** pc still looks alive but no ping/pong landed inside the watchdog window. */
	| "heartbeat-timeout"
	/** We quit the process (`/exit`). */
	| "local-exit"
	/** We dropped this session but stayed in the app (`/disconnect`). */
	| "local-disconnect"
	/** The peer sent a `bye` saying it was quitting. */
	| "remote-exit"
	/** The peer sent a `bye` saying it was dropping the session. */
	| "remote-disconnect";

/**
 * Connection state as the app cares about it.
 *
 * Deliberately narrower than werift's six-value `RTCPeerConnectionState`:
 * `disconnected` / `closed` / `failed` all collapse into a single `closed`
 * (they differ only in how the transport died, which is what `reason`
 * captures), and `new` is dropped entirely. Normalising here — rather than
 * re-deriving "is this terminal?" at every call site — is what keeps the
 * terminal-state predicate from drifting between layers.
 */
export type ConnectionEvent =
	| { readonly state: "connecting" | "connected" }
	| { readonly state: "closed"; readonly reason: CloseReason };

/**
 * The ONE place that decides whether a close is worth redialing.
 *
 * Only transport-level failures are retryable: the peer is presumed to still
 * want to talk to us and something in between broke. Every intentional
 * teardown — ours or theirs — is final, because retrying it is guaranteed to
 * fail (or, worse, to reconnect to a peer that deliberately left).
 */
export function isRetryable(reason: CloseReason): boolean {
	return reason === "network" || reason === "heartbeat-timeout";
}

/** Map an inbound `bye`'s reason onto the local `CloseReason` vocabulary. */
export function remoteReasonFor(reason: ByeReason): CloseReason {
	return reason === "exit" ? "remote-exit" : "remote-disconnect";
}

/**
 * Normalise a werift `RTCPeerConnection.connectionState` string.
 *
 * Returns `null` for `"new"` — the pre-handshake state carries no
 * information for the app, and letting it through would have it read as a
 * terminal event by anything that tests "not connected and not connecting".
 */
export function normalizeConnectionState(
	state: string,
): "connecting" | "connected" | "closed" | null {
	if (state === "connecting" || state === "connected") return state;
	if (state === "disconnected" || state === "closed" || state === "failed") return "closed";
	return null;
}

import type { Message } from "@wenchat/protocol";

/**
 * Upper bound on the retained chat log. Without a cap, `toDisplayLines` has to
 * re-wrap an ever-growing array on every resize and the process leaks memory
 * across a long-lived session. Two paths share this cap (the React state in
 * `App.tsx` and the connection-machine's `appendSystemMessage`), so the
 * number lives here as the single source of truth.
 */
export const MAX_MESSAGES = 2000;

/**
 * Append a message, dropping the oldest once the log exceeds
 * {@link MAX_MESSAGES}. Returns a new array — the previous one is untouched.
 */
export function appendCapped(previous: readonly Message[], message: Message): Message[] {
	const next = [...previous, message];
	return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
}

import type { CloseReason, ConnectionEvent } from "../../src/connectionState";

const DEFAULT_TIMEOUT_MS = 2000;
const POLL_MS = 10;

/**
 * Polling helpers over a recorded `ConnectionEvent[]`.
 *
 * werift drives state changes from its own async callbacks, so tests observe
 * them by pushing into an array and waiting for the shape they need. These
 * live in one place because the unit and integration suites need the same
 * three questions answered: did we reach `connected`, did we close, and with
 * what reason.
 */

function describeEvents(events: readonly ConnectionEvent[]): string {
	return events.map((e) => (e.state === "closed" ? `closed(${e.reason})` : e.state)).join(",");
}

export async function waitForState(
	events: readonly ConnectionEvent[],
	target: "connecting" | "connected",
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (events.some((e) => e.state === target)) return;
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
	throw new Error(`timed out waiting for "${target}", saw: ${describeEvents(events)}`);
}

/** Resolve with the reason of the first terminal event to land. */
export async function waitForClose(
	events: readonly ConnectionEvent[],
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CloseReason> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const closed = events.find((e) => e.state === "closed");
		if (closed && closed.state === "closed") return closed.reason;
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
	throw new Error(`timed out waiting for a close, saw: ${describeEvents(events)}`);
}

/** Wait until `target` has been observed at least `count` times. */
export async function waitForCount(
	events: readonly ConnectionEvent[],
	target: ConnectionEvent["state"],
	count: number,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (events.filter((e) => e.state === target).length >= count) return;
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
	throw new Error(`timed out waiting for ${count}×"${target}", saw: ${describeEvents(events)}`);
}

export function countState(
	events: readonly ConnectionEvent[],
	target: ConnectionEvent["state"],
): number {
	return events.filter((e) => e.state === target).length;
}

export function closeReasons(events: readonly ConnectionEvent[]): readonly CloseReason[] {
	return events.flatMap((e) => (e.state === "closed" ? [e.reason] : []));
}

import { describe, expect, it } from "bun:test";
import type { CloseReason } from "@wenchat/core";
import type { PeerInfo } from "@wenchat/protocol";
import {
	type ConnectionPhase,
	type Effect,
	IDLE_PHASE,
	MAX_RECONNECT_ATTEMPTS,
	RECONNECT_BACKOFF_MS,
	reduce,
	toStatusBarStatus,
} from "../src/connectionMachine";

const alice: PeerInfo = {
	id: "alice-id",
	displayName: "alice",
	signalingHost: "192.168.1.10",
	signalingPort: 4242,
};

const manual: PeerInfo = {
	id: "manual",
	displayName: "192.168.1.11:5000",
	signalingHost: "192.168.1.11",
	signalingPort: 5000,
};

const ONLINE: ConnectionPhase = { kind: "online", peer: alice };
const DIALING: ConnectionPhase = { kind: "dialing", peer: alice };
const RETRYING: ConnectionPhase = { kind: "retrying", peer: alice, attempt: 1 };

function kinds(effects: readonly Effect[]): readonly string[] {
	return effects.map((e) => e.kind);
}

function messages(effects: readonly Effect[]): readonly string[] {
	return effects.flatMap((e) => (e.kind === "system-message" ? [e.text] : []));
}

function closed(reason: CloseReason) {
	return { kind: "wire", event: { state: "closed", reason } } as const;
}

const RETRYABLE: readonly CloseReason[] = ["network", "heartbeat-timeout"];
const FINAL: readonly CloseReason[] = [
	"local-exit",
	"local-disconnect",
	"remote-exit",
	"remote-disconnect",
];

describe("connectionMachine — the retry gate", () => {
	// This is the regression the whole close-reason mechanism exists for.
	// A peer that leaves on purpose must never put us in a redial loop.
	for (const reason of FINAL) {
		it(`never schedules a retry for "${reason}"`, () => {
			for (const phase of [ONLINE, DIALING, RETRYING]) {
				const { phase: next, effects } = reduce(phase, closed(reason));
				expect(kinds(effects)).not.toContain("schedule-retry");
				expect(next).toEqual(IDLE_PHASE);
			}
		});
	}

	for (const reason of RETRYABLE) {
		it(`schedules a retry for "${reason}"`, () => {
			const { phase: next, effects } = reduce(ONLINE, closed(reason));
			expect(kinds(effects)).toContain("schedule-retry");
			expect(next).toEqual({ kind: "retrying", peer: alice, attempt: 1 });
		});
	}

	it("cleans up in-flight transfers on every terminal reason", () => {
		for (const reason of [...RETRYABLE, ...FINAL]) {
			expect(kinds(reduce(ONLINE, closed(reason)).effects)).toContain("dispose-transfers");
		}
	});

	it("goes idle on a terminal event with no peer, without messaging", () => {
		const { phase, effects } = reduce(IDLE_PHASE, closed("network"));
		expect(phase).toEqual(IDLE_PHASE);
		expect(messages(effects)).toEqual([]);
	});
});

describe("connectionMachine — farewell wording", () => {
	const cases: ReadonlyArray<readonly [CloseReason, string]> = [
		["remote-exit", "alice left the chat."],
		["remote-disconnect", "alice disconnected."],
		["local-disconnect", "Disconnected from alice (192.168.1.10:4242)"],
	];

	for (const [reason, text] of cases) {
		it(`"${reason}" reads as "${text}"`, () => {
			expect(messages(reduce(ONLINE, closed(reason)).effects)).toEqual([text]);
		});
	}

	it("stays silent for local-exit — that handler logs its own notice", () => {
		expect(messages(reduce(ONLINE, closed("local-exit")).effects)).toEqual([]);
	});

	it("names a manually dialed peer by endpoint", () => {
		const phase: ConnectionPhase = { kind: "online", peer: manual };
		expect(messages(reduce(phase, closed("remote-exit")).effects)).toEqual([
			"192.168.1.11:5000 left the chat.",
		]);
	});
});

describe("connectionMachine — backoff progression", () => {
	it("walks the backoff table across successive failures", () => {
		let phase: ConnectionPhase = ONLINE;
		const delays: number[] = [];

		const first = reduce(phase, closed("network"));
		phase = first.phase;
		delays.push(delayOf(first.effects));

		for (let i = 1; i < MAX_RECONNECT_ATTEMPTS; i++) {
			const round = reduce(phase, { kind: "dial-failed" });
			phase = round.phase;
			delays.push(delayOf(round.effects));
		}

		expect(delays).toEqual([...RECONNECT_BACKOFF_MS]);
		expect(phase).toEqual({ kind: "retrying", peer: alice, attempt: MAX_RECONNECT_ATTEMPTS });
	});

	it("gives up after the table is exhausted", () => {
		const exhausted: ConnectionPhase = {
			kind: "retrying",
			peer: alice,
			attempt: MAX_RECONNECT_ATTEMPTS,
		};
		const { phase, effects } = reduce(exhausted, { kind: "dial-failed" });
		expect(phase).toEqual(IDLE_PHASE);
		expect(kinds(effects)).not.toContain("schedule-retry");
		expect(messages(effects)[0]).toContain(`failed after ${MAX_RECONNECT_ATTEMPTS} attempts`);
	});

	it("dials on the timer, freeing the dead session first", () => {
		const { phase, effects } = reduce(RETRYING, { kind: "retry-fired" });
		expect(phase).toEqual(RETRYING);
		expect(kinds(effects)).toEqual(["close-active-session", "dial"]);
	});

	it("ignores a stray timer outside the retry phase", () => {
		expect(reduce(ONLINE, { kind: "retry-fired" }).effects).toEqual([]);
	});
});

describe("connectionMachine — user actions", () => {
	it("refuses to dial while a session is live or being retried", () => {
		for (const phase of [ONLINE, DIALING, RETRYING]) {
			const { phase: next, effects } = reduce(phase, { kind: "dial", peer: manual });
			expect(next).toEqual(phase);
			expect(kinds(effects)).toEqual(["system-message"]);
			expect(messages(effects)[0]).toContain("Run /disconnect first");
		}
	});

	it("dials from idle, invalidating any in-flight handshake", () => {
		const { phase, effects } = reduce(IDLE_PHASE, { kind: "dial", peer: alice });
		expect(phase).toEqual(DIALING);
		expect(kinds(effects)).toEqual(["cancel-retry", "invalidate-dials", "dial"]);
	});

	it("does NOT auto-retry a user-initiated dial that failed", () => {
		const { phase, effects } = reduce(DIALING, { kind: "dial-failed" });
		expect(phase).toEqual(IDLE_PHASE);
		expect(kinds(effects)).not.toContain("schedule-retry");
		expect(messages(effects)[0]).toBe("Failed to connect to alice (192.168.1.10:4242)");
	});

	it("closes gracefully on /disconnect and lets the wire event finish the job", () => {
		const { phase, effects } = reduce(ONLINE, { kind: "user-disconnect" });
		// Phase deliberately unchanged: the terminal event is the single
		// source of truth for both the transition and the notice.
		expect(phase).toEqual(ONLINE);
		expect(effects).toContainEqual({ kind: "close-graceful", reason: "local-disconnect" });
		expect(messages(effects)).toEqual([]);
	});

	it("reports /disconnect with nothing connected", () => {
		const { effects } = reduce(IDLE_PHASE, { kind: "user-disconnect" });
		expect(messages(effects)).toEqual(["Not connected"]);
	});

	it("sends a bye on /exit", () => {
		const { effects } = reduce(ONLINE, { kind: "user-exit" });
		expect(effects).toContainEqual({ kind: "close-graceful", reason: "local-exit" });
	});

	it("cancels a pending retry", () => {
		const { phase, effects } = reduce(RETRYING, { kind: "user-cancel" });
		expect(phase).toEqual(IDLE_PHASE);
		expect(kinds(effects)).toContain("cancel-retry");
		expect(messages(effects)).toEqual(["Reconnect cancelled."]);
	});

	it("reports /cancel with no retry in progress", () => {
		for (const phase of [IDLE_PHASE, ONLINE, DIALING]) {
			const { phase: next, effects } = reduce(phase, { kind: "user-cancel" });
			expect(next).toEqual(phase);
			expect(messages(effects)).toEqual(["No reconnect in progress."]);
		}
	});

	it("lets an inbound offer preempt a queued retry", () => {
		const { phase, effects } = reduce(RETRYING, { kind: "incoming", peer: manual });
		expect(phase).toEqual({ kind: "dialing", peer: manual });
		expect(kinds(effects)).toEqual(["cancel-retry", "invalidate-dials"]);
	});

	it("does not invalidate dials for an inbound offer while idle", () => {
		const { phase, effects } = reduce(IDLE_PHASE, { kind: "incoming", peer: alice });
		expect(phase).toEqual(DIALING);
		expect(kinds(effects)).toEqual(["cancel-retry"]);
	});
});

describe("connectionMachine — connected transition", () => {
	it("goes online and clears any pending retry", () => {
		const { phase, effects } = reduce(RETRYING, {
			kind: "wire",
			event: { state: "connected" },
		});
		expect(phase).toEqual(ONLINE);
		expect(kinds(effects)).toEqual(["cancel-retry", "system-message"]);
		expect(messages(effects)).toEqual(["Connected to alice (192.168.1.10:4242)"]);
	});

	it("ignores connected with no peer known", () => {
		const { phase, effects } = reduce(IDLE_PHASE, {
			kind: "wire",
			event: { state: "connected" },
		});
		expect(phase).toEqual(IDLE_PHASE);
		expect(effects).toEqual([]);
	});

	it("treats a bare connecting event as a no-op", () => {
		for (const phase of [IDLE_PHASE, ONLINE, DIALING, RETRYING]) {
			const result = reduce(phase, { kind: "wire", event: { state: "connecting" } });
			expect(result.phase).toEqual(phase);
			expect(result.effects).toEqual([]);
		}
	});
});

describe("toStatusBarStatus", () => {
	it("maps every phase onto the four-value status bar union", () => {
		expect(toStatusBarStatus(IDLE_PHASE)).toBe("offline");
		expect(toStatusBarStatus(DIALING)).toBe("connecting");
		expect(toStatusBarStatus(ONLINE)).toBe("online");
		expect(toStatusBarStatus(RETRYING)).toBe("reconnecting");
	});
});

function delayOf(effects: readonly Effect[]): number {
	const scheduled = effects.find((e) => e.kind === "schedule-retry");
	if (!scheduled || scheduled.kind !== "schedule-retry") {
		throw new Error(`no schedule-retry effect in [${kinds(effects).join(",")}]`);
	}
	return scheduled.delayMs;
}

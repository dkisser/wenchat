import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { TextMessage } from "@wenchat/protocol";
import { PeerConnection } from "../../src/peer";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const TERMINAL_STATES = new Set(["disconnected", "closed", "failed"]);

async function waitForCondition(
	states: string[],
	predicate: (s: string) => boolean,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && !states.some(predicate)) {
		await sleep(50);
	}
	return states.some(predicate);
}

describe("core integration", () => {
	let alice: PeerConnection;
	let bob: PeerConnection;

	beforeEach(async () => {
		alice = new PeerConnection();
		bob = new PeerConnection();
		await alice.startListening(0);
		await bob.startListening(0);
	});

	afterEach(() => {
		alice.close();
		bob.close();
	});

	it("two peers exchange a text message", async () => {
		const received: TextMessage[] = [];
		bob.onMessage((msg) => {
			if (msg.type === "text") received.push(msg);
		});

		await alice.connect("127.0.0.1", bob.getSignalingPort());

		const message: TextMessage = {
			type: "text",
			id: "m1",
			timestamp: Date.now(),
			payload: { text: "hello bob" },
		};

		alice.send(message);

		await new Promise<void>((resolve) => {
			const check = setInterval(() => {
				if (received.length > 0) {
					clearInterval(check);
					resolve();
				}
			}, 50);
			setTimeout(() => {
				clearInterval(check);
				resolve();
			}, 5000);
		});

		expect(received.length).toBeGreaterThan(0);
		expect(received[0].payload.text).toBe("hello bob");
	});

	it("heartbeat ping/pong messages never reach user-facing onMessage", async () => {
		const received: { type: string }[] = [];
		bob.onMessage((msg) => received.push(msg));

		await alice.connect("127.0.0.1", bob.getSignalingPort());
		// Give the heartbeat enough time to fire several pings/pongs.
		await sleep(2500);

		const heartbeats = received.filter((m) => m.type === "ping" || m.type === "pong");
		expect(heartbeats.length).toBe(0);
	});

	it("abrupt peer death is reported as a terminal state within ~6s", async () => {
		const bobStates: string[] = [];
		bob.onStateChange((state) => bobStates.push(state));

		await alice.connect("127.0.0.1", bob.getSignalingPort());

		const reachedConnected = await waitForCondition(bobStates, (s) => s === "connected", 5000);
		expect(reachedConnected).toBe(true);

		// Simulate "process killed" — close alice's pc directly,
		// bypassing the public `close()` path. Bob should see a terminal
		// state (whichever WebRTC or the heartbeat happens to emit first).
		(alice as unknown as { pc: { close(): void } }).pc.close();

		const sawTerminal = await waitForCondition(bobStates, (s) => TERMINAL_STATES.has(s), 8000);
		expect(sawTerminal).toBe(true);
		// Listener should only emit a terminal state once — the
		// `terminated` guard suppresses duplicates.
		const terminalEmissions = bobStates.filter((s) => TERMINAL_STATES.has(s));
		expect(terminalEmissions.length).toBe(1);
	}, 15000);
});

import { describe, expect, it } from "bun:test";
import type { Message } from "@wenchat/protocol";
import { HeartbeatScheduler } from "../../src/heartbeat";

type Harness = {
	sends: Message[];
	timeouts: { count: number };
	hb: HeartbeatScheduler;
};

function makeHarness(overrides: { intervalMs?: number; timeoutMs?: number } = {}): Harness {
	const sends: Message[] = [];
	const timeouts = { count: 0 };
	const hb = new HeartbeatScheduler({
		send: (m) => sends.push(m),
		onTimeout: () => {
			timeouts.count += 1;
		},
		intervalMs: overrides.intervalMs ?? 20,
		timeoutMs: overrides.timeoutMs ?? 40,
	});
	return { sends, timeouts, hb };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("HeartbeatScheduler", () => {
	it("emits pings on the configured cadence when running", async () => {
		const h = makeHarness({ intervalMs: 20, timeoutMs: 5000 });
		h.hb.start();
		await sleep(95);
		h.hb.stop();
		const pings = h.sends.filter((m) => m.type === "ping");
		expect(pings.length).toBeGreaterThanOrEqual(3);
	});

	it("replies to an incoming ping with a pong carrying the same nonce", () => {
		const h = makeHarness();
		h.hb.handleIncoming({
			type: "ping",
			id: "x",
			timestamp: 0,
			payload: { nonce: "n1" },
		});
		const reply = h.sends.find((m) => m.type === "pong");
		expect(reply).toBeDefined();
		if (reply?.type === "pong") {
			expect(reply.payload.nonce).toBe("n1");
		}
	});

	it("ignores text/file messages — does not emit anything", () => {
		const h = makeHarness();
		h.hb.handleIncoming({
			type: "text",
			id: "x",
			timestamp: 0,
			payload: { text: "hi" },
		});
		expect(h.sends.length).toBe(0);
	});

	it("matching pong arms the watchdog and prevents timeout", async () => {
		const h = makeHarness({ intervalMs: 20, timeoutMs: 60 });
		h.hb.start();
		// Continuously reply to the most recent ping so the watchdog stays armed.
		const responder = setInterval(() => {
			const last = [...h.sends].reverse().find((m) => m.type === "ping");
			if (last?.type === "ping") {
				h.hb.handleIncoming({
					type: "pong",
					id: "x",
					timestamp: 0,
					payload: { nonce: last.payload.nonce },
				});
			}
		}, 5);
		await sleep(140);
		clearInterval(responder);
		h.hb.stop();
		expect(h.timeouts.count).toBe(0);
	});

	it("deadline fires when peer is silent for longer than timeoutMs", async () => {
		const h = makeHarness({ intervalMs: 20, timeoutMs: 30 });
		h.hb.start();
		await sleep(80);
		h.hb.stop();
		expect(h.timeouts.count).toBe(1);
	});

	it("late pong after timeout does not retrigger (idempotent stop)", async () => {
		const h = makeHarness({ intervalMs: 20, timeoutMs: 30 });
		h.hb.start();
		await sleep(80);
		expect(h.timeouts.count).toBe(1);
		h.hb.handleIncoming({
			type: "pong",
			id: "x",
			timestamp: 0,
			payload: { nonce: "stale-nonce" },
		});
		await sleep(40);
		expect(h.timeouts.count).toBe(1);
	});

	it("stop() before any tick prevents pings and timeouts", async () => {
		const h = makeHarness({ intervalMs: 20, timeoutMs: 30 });
		h.hb.stop();
		await sleep(80);
		expect(h.sends.filter((m) => m.type === "ping").length).toBe(0);
		expect(h.timeouts.count).toBe(0);
	});

	it("start()/stop() are idempotent", () => {
		const h = makeHarness();
		h.hb.start();
		h.hb.start();
		h.hb.stop();
		h.hb.stop();
		// No throw, no extra timers.
	});
});

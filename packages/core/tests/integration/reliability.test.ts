import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextMessage } from "@wenchat/protocol";
import { type ConnectionEvent, normalizeConnectionState } from "../../src/connectionState";
import { PeerConnection } from "../../src/peer";
import { waitForState } from "../helpers/connectionEvents";
import { suppressUdpRefused } from "../helpers/udpSuppression";

// End-to-end reliability (PR-3, ADR 0003 Q3/Q4/Q10):
//
//   * Every outbound chat message carries a monotonic `seq`.
//   * The sender's outbox drains within the ACK-cadence budget (200ms
//     idle + every-16 inbound messages), so a healthy round-trip
//     resolves in well under a second.
//   * `swapSession` (network drop → reconnect) preserves seq continuity:
//     a post-swap message carries `seq=lastKnown+1`, never resets to 1
//     (which would make the receiver's PR-4 gap detector scream about
//     a fraud replay).
//   * A late or out-of-order ACK does not roll the sender's outbox head
//     backward (PR-2 review edge #2 — OutboxStore.markAcked's monotonic
//     guard, exercised end-to-end through the scheduler).
//
// Each test wires two real `PeerConnection`s on 127.0.0.1 + a `setInterval`
// poll over a recorded state list, matching the existing integration test
// style (AGENTS.md: ~5s timeouts, don't "fix" the speed).

let restoreUdpSuppression: () => void = () => {};
beforeEach(() => {
	restoreUdpSuppression = suppressUdpRefused();
});
afterEach(() => {
	restoreUdpSuppression();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function pollUntil<T>(
	items: T[],
	predicate: (item: T) => boolean,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (items.some(predicate)) return true;
		await sleep(50);
	}
	return false;
}

describe("reliability: 50-message burst", () => {
	let alice: PeerConnection;
	let bob: PeerConnection;
	let scratchDir: string;

	beforeEach(async () => {
		scratchDir = await mkdtemp(join(tmpdir(), "wenchat-reliability-"));
		alice = new PeerConnection();
		bob = new PeerConnection();
		await alice.startListening(0);
		await bob.startListening(0);
	});

	afterEach(async () => {
		alice.close();
		bob.close();
		await rm(scratchDir, { recursive: true, force: true });
	});

	it("delivers 50 messages with strictly increasing seqs and drains the sender's outbox", async () => {
		const bobReceived: TextMessage[] = [];
		const unsub = bob.onMessage((msg) => {
			if (msg.type === "text") bobReceived.push(msg);
		});

		await alice.connect("127.0.0.1", bob.getSignalingPort());
		const events: ConnectionEvent[] = [];
		alice.onStateChange((e) => events.push(e));
		await waitForState(events, "connected", 5000);

		// Burst-send 50 messages. The receiver should see them all in
		// arrival order, each with a strictly-increasing seq.
		for (let i = 0; i < 50; i++) {
			alice.send({
				type: "text",
				id: `m${i}`,
				timestamp: Date.now(),
				payload: { text: `msg-${i}` },
			});
		}

		const got50 = await pollUntil(bobReceived, (m) => m.payload.text === "msg-49", 10000);
		expect(got50).toBe(true);

		// Seq is monotonic and contiguous: 1..50. Under SCTP-ordered
		// delivery within a session, "monotonic" is what we observe —
		// cross-session gap modeling is PR-4.
		const seqs = bobReceived.map((m) => m.seq);
		expect(seqs).toHaveLength(50);
		for (let i = 0; i < 50; i++) {
			expect(seqs[i]).toBe(i + 1);
		}

		// The sender's outbox drains within the ACK-cadence budget
		// (200 ms idle + propagation). 2 s is a comfortable upper bound
		// for the loopback path.
		await sleep(2000);
		expect(alice.outboxSize()).toBe(0);

		unsub();
	}, 30000);
});

describe("reliability: swapSession preserves seq continuity", () => {
	let alice: PeerConnection;
	let bob: PeerConnection;
	let scratchDir: string;

	beforeEach(async () => {
		scratchDir = await mkdtemp(join(tmpdir(), "wenchat-reliability-"));
		alice = new PeerConnection();
		bob = new PeerConnection();
		await alice.startListening(0);
		await bob.startListening(0);
	});

	afterEach(async () => {
		alice.close();
		bob.close();
		await rm(scratchDir, { recursive: true, force: true });
	});

	it("post-swap seqs continue from pre-swap + 1 (no reset, no fraud gap)", async () => {
		const bobReceived: TextMessage[] = [];
		const unsub = bob.onMessage((msg) => {
			if (msg.type === "text") bobReceived.push(msg);
		});

		// First session.
		await alice.connect("127.0.0.1", bob.getSignalingPort());
		const aliceEvents: ConnectionEvent[] = [];
		alice.onStateChange((e) => aliceEvents.push(e));
		await waitForState(aliceEvents, "connected", 5000);

		for (let i = 0; i < 10; i++) {
			alice.send({
				type: "text",
				id: `pre-${i}`,
				timestamp: Date.now(),
				payload: { text: `pre-${i}` },
			});
		}

		const got10 = await pollUntil(bobReceived, (m) => m.payload.text === "pre-9", 8000);
		expect(got10).toBe(true);

		// Force-close alice's pc, release the dead session, reconnect.
		alice._forceCloseActivePc();
		const aliceTerminal = await pollUntil(
			aliceEvents,
			(e) => normalizeConnectionState(e.state) === "closed",
			8000,
		);
		expect(aliceTerminal).toBe(true);
		alice.closeActiveSession();

		// Bob observes the terminal close too (its pc is still up but
		// the data channel died).
		const bobEvents: ConnectionEvent[] = [];
		bob.onStateChange((e) => bobEvents.push(e));
		const bobSawClose = await pollUntil(
			bobEvents,
			(e) => normalizeConnectionState(e.state) === "closed",
			8000,
		);
		expect(bobSawClose).toBe(true);

		// Reconnect on the same PeerConnection.
		await alice.connect("127.0.0.1", bob.getSignalingPort());
		const aliceEvents2: ConnectionEvent[] = [];
		const unsub2 = alice.onStateChange((e) => aliceEvents2.push(e));
		await waitForState(aliceEvents2, "connected", 10000);
		unsub2();

		// Send a post-swap message — it must carry seq=11, not seq=1.
		alice.send({
			type: "text",
			id: "post-0",
			timestamp: Date.now(),
			payload: { text: "post-0" },
		});

		const gotPost = await pollUntil(bobReceived, (m) => m.payload.text === "post-0", 8000);
		expect(gotPost).toBe(true);

		// The very first seq we set up pre-swap was 1; the post-swap
		// message must continue from 11. (Bob's gap detector — PR-4 — is
		// not on this branch yet; in PR-3 we assert the sender's behavior
		// is correct.)
		const post = bobReceived.find((m) => m.payload.text === "post-0");
		expect(post?.seq).toBe(11);

		unsub();
	}, 45000);
});

describe("reliability: outbox monotonic guard (PR-2 review edge #2)", () => {
	// The guard lives inside OutboxStore.markAcked; this integration
	// test exercises the realistic happy path where the sender sends a
	// burst, the receiver ACKs back, and the sender's outbox head
	// advances monotonically. A buggy peer's late ACK with a lower
	// value would be the regression target — we cannot easily force that
	// from outside the black box without a transport mock, so the unit
	// suite (messageAck.test.ts "monotonic guard: a late ACK with seq <
	// current head is silently ignored") is the load-bearing assertion.
	// Here we simply verify that under normal operation the sender's
	// outbox drains to zero, which is the observable consequence of the
	// guard being respected.
	let alice: PeerConnection;
	let bob: PeerConnection;
	let scratchDir: string;

	beforeEach(async () => {
		scratchDir = await mkdtemp(join(tmpdir(), "wenchat-reliability-"));
		alice = new PeerConnection();
		bob = new PeerConnection();
		await alice.startListening(0);
		await bob.startListening(0);
	});

	afterEach(async () => {
		alice.close();
		bob.close();
		await rm(scratchDir, { recursive: true, force: true });
	});

	it("a normal-roundtrip burst leaves the sender's outbox empty (no regression)", async () => {
		await alice.connect("127.0.0.1", bob.getSignalingPort());
		const events: ConnectionEvent[] = [];
		alice.onStateChange((e) => events.push(e));
		await waitForState(events, "connected", 5000);

		for (let i = 0; i < 10; i++) {
			alice.send({
				type: "text",
				id: `m${i}`,
				timestamp: Date.now(),
				payload: { text: `m${i}` },
			});
		}

		// Wait for at least one full ACK cycle. We sent fewer than 16
		// messages, so the every-16 trigger does NOT fire — we rely on
		// the 200ms idle timer. 1.5 s is plenty.
		await sleep(1500);
		expect(alice.outboxSize()).toBe(0);
	}, 30000);
});

describe("reliability: in-order delivery under SCTP", () => {
	// PR-3's primary correctness property for chat: every message sent
	// arrives on the peer side, in send-order, with the same seq. PR-4
	// will add the gap-detector on top of this; PR-3 is the foundation.
	let alice: PeerConnection;
	let bob: PeerConnection;
	let scratchDir: string;

	beforeEach(async () => {
		scratchDir = await mkdtemp(join(tmpdir(), "wenchat-reliability-"));
		alice = new PeerConnection();
		bob = new PeerConnection();
		await alice.startListening(0);
		await bob.startListening(0);
	});

	afterEach(async () => {
		alice.close();
		bob.close();
		await rm(scratchDir, { recursive: true, force: true });
	});

	it("a 100-message burst arrives in send-order with strictly increasing seqs", async () => {
		const bobReceived: TextMessage[] = [];
		const unsub = bob.onMessage((msg) => {
			if (msg.type === "text") bobReceived.push(msg);
		});

		await alice.connect("127.0.0.1", bob.getSignalingPort());
		const events: ConnectionEvent[] = [];
		alice.onStateChange((e) => events.push(e));
		await waitForState(events, "connected", 5000);

		for (let i = 0; i < 100; i++) {
			alice.send({
				type: "text",
				id: `m${i}`,
				timestamp: Date.now(),
				payload: { text: `burst-${i}` },
			});
		}

		const got100 = await pollUntil(bobReceived, (m) => m.payload.text === "burst-99", 15000);
		expect(got100).toBe(true);

		expect(bobReceived).toHaveLength(100);
		for (let i = 0; i < 100; i++) {
			expect(bobReceived[i].payload.text).toBe(`burst-${i}`);
			expect(bobReceived[i].seq).toBe(i + 1);
		}

		await sleep(2500);
		expect(alice.outboxSize()).toBe(0);

		unsub();
	}, 30000);
});

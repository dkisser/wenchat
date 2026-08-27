import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { TextMessage } from "@wenchat/protocol";
import { type ConnectionEvent, isRetryable } from "../../src/connectionState";
import { DiscoveryService } from "../../src/discovery";
import { PeerConnection } from "../../src/peer";
import { closeReasons, waitForClose, waitForState } from "../helpers/connectionEvents";
import { suppressUdpRefused } from "../helpers/udpSuppression";

// Linux CI turns ICMP port-unreachable into ECONNREFUSED on werift's dgram
// sockets after a test force-closes a pc, and bun:test's uncaughtException
// handler fails whatever test is running when the error lands — including
// unrelated ones. File-scope so the stray error is covered no matter which
// test it leaks into. See tests/helpers/udpSuppression.ts.
let restoreUdpSuppression: () => void = () => {};
beforeEach(() => {
	restoreUdpSuppression = suppressUdpRefused();
});
afterEach(() => {
	restoreUdpSuppression();
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const TERMINAL_STATES = new Set(["closed"]);

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

async function waitForMatch<T>(
	items: T[],
	predicate: (item: T) => boolean,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (items.some(predicate)) return true;
		await sleep(50);
	}
	return items.some(predicate);
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
		bob.onStateChange((e) => bobStates.push(e.state));

		await alice.connect("127.0.0.1", bob.getSignalingPort());

		const reachedConnected = await waitForCondition(bobStates, (s) => s === "connected", 5000);
		expect(reachedConnected).toBe(true);

		// Simulate "process killed" — close alice's pc directly,
		// bypassing the public `close()` path. Bob should see a terminal
		// state (whichever WebRTC or the heartbeat happens to emit first).
		alice._forceCloseActivePc();

		const sawTerminal = await waitForCondition(bobStates, (s) => TERMINAL_STATES.has(s), 8000);
		expect(sawTerminal).toBe(true);
		// Listener should only emit a terminal state once — the
		// `terminated` guard suppresses duplicates.
		const terminalEmissions = bobStates.filter((s) => TERMINAL_STATES.has(s));
		expect(terminalEmissions.length).toBe(1);
	}, 15000);

	it("a fresh PeerConnection can reconnect to a peer whose pc was previously terminated", async () => {
		// Simulates the user's bug report: "the just-disconnected end
		// reconnects and can't". A real-world CLI run means a new
		// process (new `PeerConnection` + new signaling port); bob
		// meanwhile has been up the whole time. With the pre-refactor
		// code, bob's `acceptOffer` reused its dead pc/SCTP and the
		// re-handshake failed. With Session-per-attempt, bob's
		// signaling.onOffer constructs a brand-new `Session` and ICE
		// establishes cleanly.

		// First handshake uses a throwaway alice.
		const firstAlice = new PeerConnection();
		await firstAlice.startListening(0);
		try {
			await firstAlice.connect("127.0.0.1", bob.getSignalingPort());
			firstAlice.send({
				type: "text",
				id: "first",
				timestamp: Date.now(),
				payload: { text: "first hello" },
			});

			const bobReceived: TextMessage[] = [];
			const unsubMessage = bob.onMessage((msg) => {
				if (msg.type === "text") bobReceived.push(msg);
			});
			const bobStates: string[] = [];
			const unsubState = bob.onStateChange((e) => bobStates.push(e.state));

			const gotFirst = await waitForMatch(
				bobReceived,
				(m) => m.payload.text === "first hello",
				5000,
			);
			expect(gotFirst).toBe(true);

			// Drop firstAlice's pc abruptly to leave bob with a
			// terminal-but-not-closed pc — exactly the state that broke
			// the pre-refactor `acceptOffer` path.
			firstAlice._forceCloseActivePc();
			const sawTerminal = await waitForCondition(bobStates, (s) => TERMINAL_STATES.has(s), 8000);
			expect(sawTerminal).toBe(true);

			unsubMessage();
			unsubState();

			// "Process restart": dispose firstAlice and create a fresh
			// PeerConnection for the reconnect attempt.
		} finally {
			firstAlice.close();
		}

		// A truly fresh PeerConnection. bob's `acceptOffer` runs
		// against a bob-side Session that doesn't exist yet — that's
		// the path the bug used to break.
		const secondAlice = new PeerConnection();
		await secondAlice.startListening(0);
		try {
			const bobReceived: TextMessage[] = [];
			const unsubMessage = bob.onMessage((msg) => {
				if (msg.type === "text") bobReceived.push(msg);
			});
			const bobStates: string[] = [];
			const unsubState = bob.onStateChange((e) => bobStates.push(e.state));

			await secondAlice.connect("127.0.0.1", bob.getSignalingPort());

			const secondReachConnected = await waitForCondition(
				bobStates,
				(s) => s === "connected",
				10000,
			);
			expect(secondReachConnected).toBe(true);

			secondAlice.send({
				type: "text",
				id: "second",
				timestamp: Date.now(),
				payload: { text: "second hello" },
			});

			const gotSecond = await waitForMatch(
				bobReceived,
				(m) => m.payload.text === "second hello",
				8000,
			);
			expect(gotSecond).toBe(true);

			unsubMessage();
			unsubState();
		} finally {
			secondAlice.close();
		}
	}, 30000);

	it("receiver's onIncoming fires before onStateChange('connected')", async () => {
		const bobEvents: string[] = [];
		bob.onIncoming(() => bobEvents.push("incoming"));
		bob.onStateChange((e) => bobEvents.push(`state:${e.state}`));

		await alice.connect("127.0.0.1", bob.getSignalingPort());

		const reachedConnected = await waitForCondition(
			bobEvents,
			(e) => e === "state:connected",
			5000,
		);
		expect(reachedConnected).toBe(true);

		const incomingIdx = bobEvents.indexOf("incoming");
		const connectedIdx = bobEvents.indexOf("state:connected");
		expect(incomingIdx).toBeGreaterThanOrEqual(0);
		expect(connectedIdx).toBeGreaterThanOrEqual(0);
		expect(incomingIdx).toBeLessThan(connectedIdx);
	});

	it("the same alice can reconnect after her pc is force-closed, with messages flowing again", async () => {
		// Counterpart to "a fresh PeerConnection can reconnect…" (which
		// models a process restart). This test models the App.tsx
		// reconnect path: the same `PeerConnection` survives a network
		// drop, releases the dead session's UDP/STUN resources via
		// `closeActiveSession`, and re-handshakes. Bob has been up the
		// whole time, so this exercises the receiver-side `acceptOffer`
		// building a fresh session against a re-dialing initiator too.
		const bobReceived: TextMessage[] = [];
		const unsubMessage = bob.onMessage((msg) => {
			if (msg.type === "text") bobReceived.push(msg);
		});
		const bobStates: string[] = [];
		const unsubState = bob.onStateChange((e) => bobStates.push(e.state));

		// First session.
		await alice.connect("127.0.0.1", bob.getSignalingPort());
		const firstConnected = await waitForCondition(bobStates, (s) => s === "connected", 5000);
		expect(firstConnected).toBe(true);

		alice.send({
			type: "text",
			id: "first",
			timestamp: Date.now(),
			payload: { text: "first hello" },
		});
		const gotFirst = await waitForMatch(bobReceived, (m) => m.payload.text === "first hello", 5000);
		expect(gotFirst).toBe(true);

		// Network-driven close on alice's side.
		alice._forceCloseActivePc();
		const bobSawTerminal = await waitForCondition(bobStates, (s) => TERMINAL_STATES.has(s), 8000);
		expect(bobSawTerminal).toBe(true);

		// Release alice's dead session resources. This is the hook App.tsx
		// fires after its `onStateChange("closed")` listener — without it
		// the new pc's ICE stalls in "checking".
		alice.closeActiveSession();

		// Reconnect on the same PeerConnection. Count connected events so
		// we wait for the SECOND one (bob sees two distinct sessions).
		const baselineConnected = bobStates.filter((s) => s === "connected").length;
		await alice.connect("127.0.0.1", bob.getSignalingPort());
		const reconnected = await waitForCondition(
			bobStates,
			(s) =>
				s === "connected" && bobStates.filter((x) => x === "connected").length > baselineConnected,
			10000,
		);
		expect(reconnected).toBe(true);

		alice.send({
			type: "text",
			id: "second",
			timestamp: Date.now(),
			payload: { text: "second hello" },
		});
		const gotSecond = await waitForMatch(
			bobReceived,
			(m) => m.payload.text === "second hello",
			8000,
		);
		expect(gotSecond).toBe(true);

		unsubMessage();
		unsubState();
	}, 30000);

	// The regression this whole close-reason mechanism exists for: a peer
	// that leaves on purpose must NOT put the other end into a reconnect
	// loop. Before `bye`, alice's /disconnect and alice's Wi-Fi dying
	// produced the identical event on bob, so bob burned a full 28-second
	// backoff window redialing a peer that had deliberately hung up.
	//
	// Each of these waits for a round-tripped text message, not just for
	// bob's pc to report `connected`: `connect()` resolves once the answer
	// SDP is applied, which can be BEFORE alice's data channel is open. A
	// `bye` sent into a not-yet-open channel is silently dropped (it is
	// best-effort by design), so asserting on the pc state alone made this
	// test race the SCTP handshake.
	async function establishVerifiedSession(): Promise<ConnectionEvent[]> {
		const bobEvents: ConnectionEvent[] = [];
		bob.onStateChange((e) => bobEvents.push(e));
		const bobReceived: TextMessage[] = [];
		const unsubMessage = bob.onMessage((m) => {
			if (m.type === "text") bobReceived.push(m);
		});

		await alice.connect("127.0.0.1", bob.getSignalingPort());
		await waitForState(bobEvents, "connected", 5000);

		// Round-trip a message so we know the data plane — not just ICE — is
		// up on BOTH ends before we exercise the teardown.
		alice.send({
			type: "text",
			id: "probe",
			timestamp: Date.now(),
			payload: { text: "probe" },
		});
		const probe = await waitForMatch(bobReceived, (m) => m.payload.text === "probe", 8000);
		expect(probe).toBe(true);
		unsubMessage();
		return bobEvents;
	}

	it("a graceful /disconnect reaches the peer as remote-disconnect, not network", async () => {
		const bobEvents = await establishVerifiedSession();

		await alice.closeGracefully("local-disconnect");

		expect(await waitForClose(bobEvents, 8000)).toBe("remote-disconnect");
		// Still exactly one terminal event — the `terminated` guard dedupes
		// the pc-level close that follows the bye.
		expect(closeReasons(bobEvents)).toEqual(["remote-disconnect"]);
	}, 30000);

	it("a graceful /exit reaches the peer as remote-exit", async () => {
		const bobEvents = await establishVerifiedSession();

		await alice.closeGracefully("local-exit");

		expect(await waitForClose(bobEvents, 8000)).toBe("remote-exit");
	}, 30000);

	it("an abrupt death still reaches the peer as a retryable network close", async () => {
		// The other half of the contract: making intentional closes
		// non-retryable must NOT make real network drops non-retryable.
		const bobEvents = await establishVerifiedSession();

		alice._forceCloseActivePc();

		expect(isRetryable(await waitForClose(bobEvents, 10000))).toBe(true);
	}, 30000);
});

describe("core integration: discovery ↔ signaling wiring", () => {
	// Regression: when `cli` is launched without a port arg, main.tsx hands
	// `signalingPort = 0` to startListening(). Node binds an ephemeral port
	// and `getSignalingPort()` is the only way to read it back. The mDNS
	// publish must use that resolved port — publishing 0 makes parseService
	// drop the peer on the LAN. This test exercises the contract between
	// PeerConnection and DiscoveryService: the caller resolves the real
	// port first, then publishes.
	it("publishes the port actually bound by startListening(0)", async () => {
		const published: Array<{ port: number; txt: { signalingPort: string } }> = [];
		const fakeBonjour = {
			publish: (opts: Record<string, unknown>) => {
				published.push(opts as { port: number; txt: { signalingPort: string } });
				return {
					stop: (cb: () => void) => cb(),
					on: (event: "up" | "error", handler: (arg?: unknown) => void) => {
						if (event === "up") queueMicrotask(() => handler());
					},
				};
			},
			find: () => ({
				stop: () => {},
				on: (_event: "up" | "down", _handler: (service: unknown) => void) => {},
			}),
		};

		const peer = new PeerConnection();
		const discovery = new DiscoveryService(fakeBonjour as never);

		try {
			await peer.startListening(0);
			const realPort = peer.getSignalingPort();
			expect(realPort).toBeGreaterThan(0);

			await discovery.start("alice", realPort);

			expect(published.length).toBe(1);
			expect(published[0].port).toBe(realPort);
			expect(published[0].txt.signalingPort).toBe(String(realPort));
		} finally {
			await discovery.stop().catch(() => {});
			peer.close();
		}
	});
});

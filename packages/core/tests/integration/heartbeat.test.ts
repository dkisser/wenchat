import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileReceiver } from "../../src/fileTransfer";
import { PeerConnection } from "../../src/peer";
import { Session } from "../../src/session";
import { suppressUdpRefused } from "../helpers/udpSuppression";

/**
 * Regression tests for the 2026-09-21 incident: the watchdog used to count
 * only ping/pong as liveness, so it killed healthy mid-transfer connections
 * once the peer's pings queued behind bulk data. The fix re-arms the
 * watchdog on EVERY inbound frame — Session.attachTransport feeds
 * `noteInbound` for both messages (session.ts) and file chunks.
 *
 * The heartbeat schedule is overridden so pings NEVER fire during these
 * tests (interval ≫ test duration). That closes the masking loophole: the
 * only liveness signal left is `noteInbound`, so deleting either call
 * under test makes the watchdog fire inside the first window and the
 * assertions below go red.
 */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Both directions are exercised so neither peer depends on ping/pong:
//   * text test — two-way text feeds the message-path `noteInbound`;
//   * chunk test — chunks feed the receiver's chunk-path `noteInbound`,
//     keepalive texts feed the sender's message-path one.
const WATCHDOG_MS = 800;

/** The acceptor's transport attaches on werift's `ondatachannel`, which
 *  races `connect()`'s resolution — the first `bob.send` can hit "Data
 *  channel not ready". Retry until the channel exists (bounded).
 *
 *  `control: true` dispatches via `sendControlMessage` — no seq, no
 *  outbox, and crucially no `message-ack` on the way back. The file test's
 *  keepalive MUST use it: a regular send is ACKed by the peer, and the ACK
 *  would re-arm the RECEIVER through the message path, masking the
 *  chunk-path wiring under test. */
async function sendWithRetry(
	pc: PeerConnection,
	make: () => Parameters<PeerConnection["send"]>[0],
	control = false,
): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			if (control) {
				pc.sendControlMessage(make());
			} else {
				pc.send(make());
			}
			return;
		} catch {
			if (attempt >= 50) throw new Error("peer channel never became ready");
			await sleep(20);
		}
	}
}

describe("core integration: heartbeat liveness over inbound traffic", () => {
	let alice: PeerConnection;
	let bob: PeerConnection;
	let scratchDir: string;
	let downloadDir: string;
	let aliceClosed: string[];
	let bobClosed: string[];
	let restoreUdpSuppression: () => void = () => {};

	beforeEach(async () => {
		// Shrink the watchdog and stretch the ping interval BEFORE the
		// sessions are constructed: 800 ms makes the old buggy wiring fail
		// fast, and a 60 s ping interval guarantees no ping/pong pair can
		// mask the missing re-arm (the auto-pong is the only other path
		// that re-arms the watchdog).
		Session._setHeartbeatTimingForTest({ intervalMs: 60_000, timeoutMs: WATCHDOG_MS });
		scratchDir = await mkdtemp(join(tmpdir(), "wenchat-it-hb-"));
		downloadDir = await mkdtemp(join(tmpdir(), "wenchat-it-hb-dl-"));
		alice = new PeerConnection();
		bob = new PeerConnection();
		await alice.startListening(0);
		await bob.startListening(0);
		const bobReceiver = new FileReceiver({
			downloadDir,
			sendMessage: (m) => bob.sendControlMessage(m),
		});
		bob.onMessage((message) => bobReceiver.handleMessage(message));
		bob.onFileChunk((chunk) => bobReceiver.handleChunk(chunk));
		aliceClosed = [];
		bobClosed = [];
		alice.onStateChange((event) => {
			if (event.state === "closed") aliceClosed.push(event.reason);
		});
		bob.onStateChange((event) => {
			if (event.state === "closed") bobClosed.push(event.reason);
		});
		restoreUdpSuppression = suppressUdpRefused();
	});

	afterEach(async () => {
		Session._setHeartbeatTimingForTest(undefined);
		restoreUdpSuppression();
		alice.close();
		bob.close();
		await rm(scratchDir, { recursive: true, force: true });
		await rm(downloadDir, { recursive: true, force: true });
	});

	it("two-way text traffic re-arms the watchdog — no ping/pong needed", async () => {
		await alice.connect("127.0.0.1", bob.getSignalingPort());
		// >2 watchdog windows of traffic in both directions at 10× the
		// cadence margin. Without `noteInbound` the first watchdog armed
		// at `connected` fires at +800 ms and the assertions go red.
		for (let i = 0; i < 22; i++) {
			alice.send({
				type: "text",
				id: `a${i}`,
				timestamp: Date.now(),
				payload: { text: `from-alice-${i}` },
			});
			await sendWithRetry(bob, () => ({
				type: "text",
				id: `b${i}`,
				timestamp: Date.now(),
				payload: { text: `from-bob-${i}` },
			}));
			await sleep(80);
		}
		expect(bobClosed).toEqual([]);
		expect(aliceClosed).toEqual([]);
	}, 15000);

	it("a single long transfer is kept alive by chunks alone", async () => {
		// One file spanning >2 watchdog windows. Between `file-start` and
		// `file-end` the receiver sees ONLY chunk frames — no application
		// message re-arms it — so this is the exact 2026-09-21 incident
		// shape: bulk chunks flowing, the peer's pings queued behind.
		// A shorter window than the text test's: the highWater-paced
		// transfer is guaranteed to span it (≥ ~800 ms across runners),
		// while the vacuous-pass guard below stays comfortably inside.
		Session._setHeartbeatTimingForTest({ intervalMs: 60_000, timeoutMs: 300 });
		const size = 8 * 1024 * 1024;
		const sourcePath = join(scratchDir, "big-chunks.bin");
		await writeFile(sourcePath, randomBytes(size));
		await alice.connect("127.0.0.1", bob.getSignalingPort());

		// The SENDER's inbound frames are just the per-32-chunk ACKs; trickle
		// bob→alice control texts so alice is fed via the message path while
		// bob is fed purely by chunks. Control dispatch carries no seq, so
		// alice's ack of it is elided — otherwise the returning message-ack
		// would re-arm BOB through the message path and mask the chunk-path
		// wiring under test. (The message path itself is pinned by the text
		// test above.)
		const keepalive = setInterval(() => {
			void sendWithRetry(
				bob,
				() => ({
					type: "text",
					id: `ka-${Date.now()}`,
					timestamp: Date.now(),
					payload: { text: "ka" },
				}),
				true,
			).catch(() => {
				// Channel torn down by the afterEach close race — harmless.
			});
		}, 150);
		const started = Date.now();
		try {
			const result = await alice.sendFile(sourcePath, { highWaterBytes: 64 * 1024 });
			expect(result.bytesSent).toBe(size);
		} finally {
			clearInterval(keepalive);
		}
		// Guard against a vacuous pass: the transfer must actually have
		// spanned >2 watchdog windows on every runner (the highWater pacing
		// keeps even a fast runner inside ≥ ~800 ms, so this is a formality
		// that fails loudly rather than silently skipping the regression).
		expect(Date.now() - started).toBeGreaterThanOrEqual(600);
		expect(bobClosed).toEqual([]);
		expect(aliceClosed).toEqual([]);
	}, 30000);
});

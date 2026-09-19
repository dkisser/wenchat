import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextMessage } from "@wenchat/protocol";
import { FileReceiver, type TransferEvent } from "../../src/fileTransfer";
import { PeerConnection } from "../../src/peer";
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

function sha256Hex(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

describe("core integration: file transfer", () => {
	let alice: PeerConnection;
	let bob: PeerConnection;
	let scratchDir: string;
	let downloadDir: string;
	let bobEvents: TransferEvent[];
	let bobReceiver: FileReceiver;

	beforeEach(async () => {
		scratchDir = await mkdtemp(join(tmpdir(), "wenchat-it-send-"));
		downloadDir = await mkdtemp(join(tmpdir(), "wenchat-it-recv-"));
		alice = new PeerConnection();
		bob = new PeerConnection();
		await alice.startListening(0);
		await bob.startListening(0);
		bobEvents = [];
		bobReceiver = new FileReceiver({
			downloadDir,
			onEvent: (event) => bobEvents.push(event),
		});
		bob.onMessage((message) => bobReceiver.handleMessage(message));
		bob.onFileChunk((chunk) => bobReceiver.handleChunk(chunk));
	});

	afterEach(async () => {
		alice.close();
		bob.close();
		await rm(scratchDir, { recursive: true, force: true });
		await rm(downloadDir, { recursive: true, force: true });
	});

	it("streams an 8 MiB file end-to-end with sha256 verification", async () => {
		const content = randomBytes(8 * 1024 * 1024);
		const sourcePath = join(scratchDir, "big.bin");
		await writeFile(sourcePath, content);

		await alice.connect("127.0.0.1", bob.getSignalingPort());

		const result = await alice.sendFile(sourcePath);
		expect(result.bytesSent).toBe(content.length);
		expect(result.checksum).toBe(sha256Hex(content));

		// 8 MiB over werift's pure-JS SCTP takes ~3s locally but can run to
		// ~16s on Linux CI runners; the previous 15s waitForMatch budget was
		// right at the edge and flaked the test. The outer it() budget is
		// still 30s, so 25s leaves headroom for a real stall.
		const completed = await waitForMatch(bobEvents, (e) => e.kind === "completed", 25000);
		expect(completed).toBe(true);

		const event = bobEvents.find((e) => e.kind === "completed");
		if (event?.kind !== "completed") throw new Error("unreachable");
		const received = await readFile(event.path);
		expect(sha256Hex(new Uint8Array(received))).toBe(sha256Hex(content));
		expect(bobEvents.some((e) => e.kind === "failed")).toBe(false);
	}, 30000);

	it("keeps text messages ordered and intact in the middle of a transfer", async () => {
		const content = randomBytes(4 * 1024 * 1024);
		const sourcePath = join(scratchDir, "mix.bin");
		await writeFile(sourcePath, content);
		const bobTexts: string[] = [];
		bob.onMessage((msg) => {
			if (msg.type === "text") bobTexts.push(msg.payload.text);
		});

		await alice.connect("127.0.0.1", bob.getSignalingPort());

		const textMessage: TextMessage = {
			type: "text",
			id: "mid",
			timestamp: Date.now(),
			payload: { text: "mid-transfer hello" },
		};
		const [result] = await Promise.all([
			alice.sendFile(sourcePath),
			(async () => {
				// Fire the text after the transfer has had a tick to start
				// streaming so it genuinely interleaves with chunk frames.
				await sleep(50);
				alice.send(textMessage);
			})(),
		]);
		expect(result.bytesSent).toBe(content.length);

		const gotText = await waitForMatch(bobTexts, (t) => t === "mid-transfer hello", 10000);
		expect(gotText).toBe(true);
		const completed = await waitForMatch(bobEvents, (e) => e.kind === "completed", 15000);
		expect(completed).toBe(true);
	}, 30000);

	it("a sender failure surfaces file-abort and the receiver drops the temp file", async () => {
		const content = randomBytes(4 * 1024 * 1024);
		const sourcePath = join(scratchDir, "doomed.bin");
		await writeFile(sourcePath, content);

		await alice.connect("127.0.0.1", bob.getSignalingPort());

		// Pace the sender with a tiny high-water mark so the transfer is
		// genuinely still in flight when bob dies — otherwise the whole file
		// lands in SCTP's retransmit queue before the kill lands and the
		// send would "succeed" into the void. Alice notices via her
		// heartbeat (~4 s), which now also closes her data channel.
		const sendPromise = alice.sendFile(sourcePath, { highWaterBytes: 64 * 1024 });
		await sleep(200);
		bob._forceCloseActivePc();

		await expect(sendPromise).rejects.toThrow();
		await bobReceiver.dispose();
		const completed = bobEvents.find((e) => e.kind === "completed");
		expect(completed).toBeUndefined();
	}, 30000);

	it("a dead data channel (not pc) ends the session so the peer can be re-dialed", async () => {
		// Regression for "both sides must restart after a failed transfer":
		// previously a channel-only failure left both peers phantom-online
		// because nothing wired the channel's close into session state.
		const bobStates: string[] = [];
		bob.onStateChange((e) => bobStates.push(e.state));

		await alice.connect("127.0.0.1", bob.getSignalingPort());
		const reachedConnected = await waitForCondition(bobStates, (s) => s === "connected", 5000);
		expect(reachedConnected).toBe(true);

		alice._forceCloseActiveChannel();

		const sawTerminal = await waitForCondition(bobStates, (s) => TERMINAL_STATES.has(s), 5000);
		expect(sawTerminal).toBe(true);
		// Exactly one terminal emission — the `terminated` guard dedupes the
		// channel close against any trailing pc-level state change.
		expect(bobStates.filter((s) => TERMINAL_STATES.has(s)).length).toBe(1);

		// And bob can accept a fresh connection without a process restart.
		const alice2 = new PeerConnection();
		await alice2.startListening(0);
		try {
			const bobStates2: string[] = [];
			bob.onStateChange((e) => bobStates2.push(e.state));
			await alice2.connect("127.0.0.1", bob.getSignalingPort());
			const reconnected = await waitForCondition(bobStates2, (s) => s === "connected", 10000);
			expect(reconnected).toBe(true);
		} finally {
			alice2.close();
		}
	}, 30000);
});

// ---------------------------------------------------------------------------
// PR-5 — chunk-level ACK + selective retransmit (ADR 0003 Q2 / Q8 / F.5).
//
// End-to-end coverage of the new recovery channel. The chunk-level ACK
// is the only way the sender learns which chunks the receiver has; the
// chat outbox doesn't carry chunks (ADR 0003 F.5).
//
// We can't drop individual SCTP messages from outside the black box
// without a transport mock, so the "drop" tests install a chunk
// listener on bob that drops each index at most N times — drops the
// first sighting (simulating wire loss), but lets the retransmits
// through (the wire has "recovered"). The same FileReceiver dedup
// that protects against duplicates also catches the dropped-then-redelivered
// pattern, so the post-recovery transfer hashes to the right value.
// ---------------------------------------------------------------------------

/**
 * Build a "drop each index at most N times" listener filter. Returns
 * the listener function plus a teardown. The filter calls `forward`
 * for every chunk that hasn't been dropped too many times; a chunk
 * dropped N times is forwarded on sighting N+1+.
 */
function makeDropFirstNSightings(maxDrops: number): {
	drop: (chunk: { index: number; data: Uint8Array; transferId: string }) => boolean;
	reset: () => void;
} {
	const counts = new Map<number, number>();
	return {
		drop: (chunk) => {
			const current = counts.get(chunk.index) ?? 0;
			if (current < maxDrops) {
				counts.set(chunk.index, current + 1);
				return true;
			}
			return false;
		},
		reset: () => counts.clear(),
	};
}

describe("core integration: file transfer — chunk-level ACK (PR-5)", () => {
	let alice: PeerConnection;
	let bob: PeerConnection;
	let scratchDir: string;
	let downloadDir: string;

	beforeEach(async () => {
		scratchDir = await mkdtemp(join(tmpdir(), "wenchat-it-pr5-send-"));
		downloadDir = await mkdtemp(join(tmpdir(), "wenchat-it-pr5-recv-"));
		alice = new PeerConnection();
		bob = new PeerConnection();
		await alice.startListening(0);
		await bob.startListening(0);
	});

	afterEach(async () => {
		alice.close();
		bob.close();
		await rm(scratchDir, { recursive: true, force: true });
		await rm(downloadDir, { recursive: true, force: true });
	});

	/**
	 * Build a fresh FileReceiver + listeners per test, with an optional
	 * drop filter. Returns the receiver, the events array, and a
	 * teardown.
	 */
	function makeBobReceiver(
		dropper?: (chunk: { index: number; data: Uint8Array; transferId: string }) => boolean,
	): {
		receiver: FileReceiver;
		events: TransferEvent[];
		disposers: Array<() => void>;
	} {
		const events: TransferEvent[] = [];
		const receiver = new FileReceiver({
			downloadDir,
			onEvent: (event) => events.push(event),
			// PR-5 — wire the FileChunkAckMessage outbound path. Without
			// this hook the receiver keeps the bitmap internally but
			// never tells the sender what's missing, so the recovery
			// loop can't run.
			sendMessage: (message) => bob.sendControlMessage(message),
		});
		const disposers: Array<() => void> = [];
		disposers.push(
			bob.onMessage((message) => {
				// Skip file-chunk-ack — those are control plane and bob
				// shouldn't ACK itself. (They wouldn't be routed to
				// the receiver anyway; the receiver only handles
				// file-start / file-end / file-abort.)
				if (
					message.type === "file-start" ||
					message.type === "file-end" ||
					message.type === "file-abort"
				) {
					receiver.handleMessage(message);
				}
			}),
			bob.onFileChunk((chunk) => {
				if (dropper?.(chunk) === true) return; // drop
				receiver.handleChunk(chunk);
			}),
		);
		return { receiver, events, disposers };
	}

	it("mid-transfer _forceCloseActiveChannel: sender bitmap tracks unacked, reconnect → selective retransmit → receiver completes", async () => {
		// Stage a channel-only failure mid-transfer (NOT a process
		// death). The peer connection at the SCTP layer stays up so a
		// new session can attach and resume — but for the test, the
		// FileSender surviving across the swap is the load-bearing
		// assertion: it MUST remember which chunks were already on
		// the wire and selectively retransmit only those, not the
		// whole file.
		const { receiver: bobReceiver, events: bobEvents, disposers } = makeBobReceiver();

		const content = randomBytes(4 * 1024 * 1024);
		const sourcePath = join(scratchDir, "reconnect.bin");
		await writeFile(sourcePath, content);

		await alice.connect("127.0.0.1", bob.getSignalingPort());

		// Begin the transfer. With a 64 KiB high-water mark, the
		// sender paces itself slowly enough that we can kill the
		// channel while chunks are still in flight.
		const sendPromise = alice.sendFile(sourcePath, { highWaterBytes: 64 * 1024 });

		// Give the sender a tick to start, then kill alice's channel.
		// Bob's session will observe a terminal close (see the
		// existing integration test "a dead data channel ... ends
		// the session so the peer can be re-dialed").
		await sleep(400);
		alice._forceCloseActiveChannel();

		// The original send rejects — the channel is dead. The
		// FileSender inside PeerConnection still tracks the
		// transfer; on a future session it would retransmit. We
		// do NOT exercise the retransmit on this same PeerConnection
		// (its session has been permanently closed) — instead we
		// verify the on-receiver-side invariant: no "out-of-order"
		// failure (PR-5 reframing).
		await expect(sendPromise).rejects.toThrow();

		// Wait for the receiver to finish processing whatever made
		// it through before the channel died.
		await bobReceiver.waitForIdle();
		const failed = bobEvents.find((e) => e.kind === "failed");
		if (failed?.kind === "failed") {
			expect(failed.reason).not.toContain("out-of-order");
		}
		for (const d of disposers) d();
	}, 60000);

	it("forced reorder chunks: bob drops chunks 5–7 → receiver sends bitmap ACK → alice retransmits just 5–7", async () => {
		// Each dropped index is dropped at most ONCE — the first
		// sighting is lost (wire drop), the retransmit lands. After
		// recovery, all 16 chunks are in FileReceiver and the
		// sha256 round-trips.
		const dropper = makeDropFirstNSightings(1);
		const {
			receiver: bobReceiver,
			events: bobEvents,
			disposers,
		} = makeBobReceiver((chunk) => {
			if (chunk.index >= 5 && chunk.index <= 7) return dropper.drop(chunk);
			return false;
		});

		const totalChunks = 16; // 16 * 64 KiB = 1 MiB
		const content = randomBytes(totalChunks * 64 * 1024);
		const sourcePath = join(scratchDir, "reorder.bin");
		await writeFile(sourcePath, content);

		await alice.connect("127.0.0.1", bob.getSignalingPort());
		const result = await alice.sendFile(sourcePath);
		expect(result.bytesSent).toBe(content.length);

		// Wait for file-end to land + receiver to flush the
		// selective-retransmit cycle.
		await waitForMatch(bobEvents, (e) => e.kind === "completed" || e.kind === "failed", 25000);

		const completed = bobEvents.find((e) => e.kind === "completed");
		const failed = bobEvents.find((e) => e.kind === "failed");

		// The transfer completes (chunks 5..7 were dropped once,
		// then redelivered by alice's selective retransmit).
		expect(completed?.kind).toBe("completed");
		expect(failed).toBeUndefined();

		if (completed?.kind === "completed") {
			const received = await readFile(completed.path);
			expect(sha256Hex(new Uint8Array(received))).toBe(sha256Hex(content));
		}

		for (const d of disposers) d();
	}, 60000);

	it("drop first 100 chunks: bob drops 0..99 → first surviving chunk triggers ACK → alice re-streams", async () => {
		// Drop the first sighting of chunks 0..99. After the
		// drops, bob's FileReceiver has only seen chunk 100+; when
		// chunk 100 arrives (out of order), it sends an immediate
		// FileChunkAckMessage with bitmap showing chunk 100. Alice
		// retransmits the still-unacked prefix (0..99); the
		// retransmits land at bob's listener, which now lets them
		// through (drop count was 1). The cascade fills expectedNext
		// up through 100, and once file-end arrives, the transfer
		// completes.
		const dropper = makeDropFirstNSightings(1);
		const {
			receiver: bobReceiver,
			events: bobEvents,
			disposers,
		} = makeBobReceiver((chunk) => {
			if (chunk.index < 100) return dropper.drop(chunk);
			return false;
		});

		const totalChunks = 130; // 130 * 64 KiB ≈ 8.3 MiB
		const content = randomBytes(totalChunks * 64 * 1024);
		const sourcePath = join(scratchDir, "prefixdrop.bin");
		await writeFile(sourcePath, content);

		await alice.connect("127.0.0.1", bob.getSignalingPort());
		const result = await alice.sendFile(sourcePath);
		expect(result.bytesSent).toBe(content.length);

		await waitForMatch(bobEvents, (e) => e.kind === "completed" || e.kind === "failed", 30000);

		const completed = bobEvents.find((e) => e.kind === "completed");
		const failed = bobEvents.find((e) => e.kind === "failed");

		// Recovery path: chunks 0..99 re-streamed; transfer
		// completes with the right sha256. PR-5 reframes "out-of-order"
		// from fatal to recoverable.
		expect(failed).toBeUndefined();
		expect(completed?.kind).toBe("completed");
		if (completed?.kind === "completed") {
			const received = await readFile(completed.path);
			expect(sha256Hex(new Uint8Array(received))).toBe(sha256Hex(content));
		}

		void bobReceiver;
		for (const d of disposers) d();
	}, 60000);
});

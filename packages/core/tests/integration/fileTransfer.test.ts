import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextMessage } from "@wenchat/protocol";
import { FileReceiver, type TransferEvent } from "../../src/fileTransfer";
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

		const completed = await waitForMatch(bobEvents, (e) => e.kind === "completed", 15000);
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
		bob.onStateChange((state) => bobStates.push(state));

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
			bob.onStateChange((state) => bobStates2.push(state));
			await alice2.connect("127.0.0.1", bob.getSignalingPort());
			const reconnected = await waitForCondition(bobStates2, (s) => s === "connected", 10000);
			expect(reconnected).toBe(true);
		} finally {
			alice2.close();
		}
	}, 30000);
});

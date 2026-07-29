import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { TextMessage } from "@wenchat/protocol";
import { PeerConnection } from "./peer";

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
});

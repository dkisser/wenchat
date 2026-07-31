import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SignalingServer } from "../../src/signaling";

describe("SignalingServer", () => {
	let server: SignalingServer;

	beforeEach(async () => {
		server = new SignalingServer();
		await server.start(0);
	});

	afterEach(async () => {
		await server.stop();
	});

	it("returns port after start", () => {
		expect(server.getPort()).toBeGreaterThan(0);
	});

	it("receives offer and returns answer", async () => {
		const offer = { type: "offer", sdp: "fake-offer" };
		const answer = { type: "answer", sdp: "fake-answer" };

		server.onOffer((received) => {
			expect(received).toEqual(offer);
			return answer;
		});

		const response = await fetch(`http://127.0.0.1:${server.getPort()}/offer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(offer),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(answer);
	});
});

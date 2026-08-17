import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { connect } from "node:net";
import { MAX_BODY_BYTES, SignalingServer } from "../../src/signaling";

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

	it("rejects an oversized body with 413 and keeps serving", async () => {
		const oversized = fetch(`http://127.0.0.1:${server.getPort()}/offer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: " ".repeat(MAX_BODY_BYTES + 1),
		});
		const response = await oversized;
		expect(response.status).toBe(413);

		// The server must still answer well-formed requests afterwards.
		server.onOffer(() => ({ type: "answer", sdp: "still-alive" }));
		const valid = await fetch(`http://127.0.0.1:${server.getPort()}/offer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "offer", sdp: "x" }),
		});
		expect(valid.status).toBe(200);
	});

	it("survives a client that resets the connection mid-body", async () => {
		// Announce a large body, send a fragment, then RST the socket. The
		// rejected body read must be caught, not bubble up as an unhandled
		// rejection that takes the process down.
		await new Promise<void>((resolve) => {
			const socket = connect(server.getPort(), "127.0.0.1", () => {
				socket.write(
					"POST /offer HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000000\r\n\r\npartial",
					() => {
						socket.destroy();
						resolve();
					},
				);
			});
			socket.on("error", () => {});
		});
		// Give the server a turn to observe the reset.
		await new Promise((r) => setTimeout(r, 50));

		server.onOffer(() => ({ type: "answer", sdp: "still-alive" }));
		const valid = await fetch(`http://127.0.0.1:${server.getPort()}/offer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "offer", sdp: "x" }),
		});
		expect(valid.status).toBe(200);
	});
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { connect } from "node:net";
import { MAX_BODY_BYTES, SignalingServer, probeSignaling } from "../../src/signaling";

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

	describe("/bye", () => {
		it("delivers a validated bye to the registered callback", async () => {
			const received: Array<{ reason: string; fromHost: string; fromPort: number }> = [];
			server.onBye((bye) => received.push(bye));

			const client = new SignalingServer();
			await client.sendBye("127.0.0.1", server.getPort(), "exit", {
				host: "192.168.1.10",
				port: 4242,
			});

			expect(received).toEqual([{ reason: "exit", fromHost: "192.168.1.10", fromPort: 4242 }]);
		});

		it("rejects an invalid reason with 400 and does not fire the callback", async () => {
			let fired = false;
			server.onBye(() => {
				fired = true;
			});

			const response = await fetch(`http://127.0.0.1:${server.getPort()}/bye`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ reason: "ragequit", fromHost: "h", fromPort: 1 }),
			});

			expect(response.status).toBe(400);
			expect(fired).toBe(false);
		});

		it("rejects a payload without a sender endpoint with 400", async () => {
			const response = await fetch(`http://127.0.0.1:${server.getPort()}/bye`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ reason: "exit" }),
			});

			expect(response.status).toBe(400);
		});

		it("sendBye throws when the peer is unreachable, so the caller can degrade gracefully", async () => {
			const client = new SignalingServer();
			const dead = new SignalingServer();
			await dead.start(0);
			const deadPort = dead.getPort();
			await dead.stop();

			await expect(
				client.sendBye("127.0.0.1", deadPort, "disconnect", { host: "h", port: 1 }),
			).rejects.toThrow();
		});
	});

	describe("/health and probeSignaling", () => {
		it("answers GET /health with 200", async () => {
			const response = await fetch(`http://127.0.0.1:${server.getPort()}/health`);
			expect(response.status).toBe(200);
		});

		it("reports alive when the server answers", async () => {
			expect(await probeSignaling("127.0.0.1", server.getPort())).toBe("alive");
		});

		it("reports alive even against a pre-/health build (any HTTP answer counts)", async () => {
			// A 404 still proves the process is up — only socket-level failure
			// distinguishes "gone" from "old build".
			const response = await fetch(`http://127.0.0.1:${server.getPort()}/definitely-not-a-route`);
			expect(response.status).toBe(404);
			expect(await probeSignaling("127.0.0.1", server.getPort())).toBe("alive");
		});

		it("reports refused when nothing listens on the port", async () => {
			const dead = new SignalingServer();
			await dead.start(0);
			const deadPort = dead.getPort();
			await dead.stop();

			expect(await probeSignaling("127.0.0.1", deadPort)).toBe("refused");
		});
	});
});

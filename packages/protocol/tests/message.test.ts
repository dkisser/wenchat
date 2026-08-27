import { describe, expect, it } from "bun:test";
import {
	type ByeMessage,
	type Message,
	type PingMessage,
	type PongMessage,
	type TextMessage,
	createBye,
	createPing,
	createPong,
} from "../src/message";

describe("message types", () => {
	it("text message has required fields", () => {
		const msg: TextMessage = {
			type: "text",
			id: "msg-1",
			timestamp: Date.now(),
			payload: { text: "hello" },
		};
		expect(msg.type).toBe("text");
		expect(msg.payload.text).toBe("hello");
	});

	it("message union includes text", () => {
		const msg: Message = {
			type: "text",
			id: "msg-2",
			timestamp: 0,
			payload: { text: "hi" },
		};
		expect(msg.type).toBe("text");
	});

	it("ping message carries nonce", () => {
		const msg: PingMessage = {
			type: "ping",
			id: "p-1",
			timestamp: Date.now(),
			payload: { nonce: "abc-123" },
		};
		expect(msg.type).toBe("ping");
		expect(msg.payload.nonce).toBe("abc-123");
	});

	it("pong message carries nonce", () => {
		const msg: PongMessage = {
			type: "pong",
			id: "po-1",
			timestamp: Date.now(),
			payload: { nonce: "abc-123" },
		};
		expect(msg.type).toBe("pong");
		expect(msg.payload.nonce).toBe("abc-123");
	});

	it("message union includes ping and pong", () => {
		const ping: Message = {
			type: "ping",
			id: "p-u",
			timestamp: 0,
			payload: { nonce: "n1" },
		};
		const pong: Message = {
			type: "pong",
			id: "po-u",
			timestamp: 0,
			payload: { nonce: "n1" },
		};
		expect(ping.type).toBe("ping");
		expect(pong.type).toBe("pong");
	});

	it("createPing generates id, timestamp, and echoes nonce", () => {
		const nonce = "nonce-abc";
		const ping = createPing(nonce);
		expect(ping.type).toBe("ping");
		expect(ping.payload.nonce).toBe(nonce);
		expect(typeof ping.id).toBe("string");
		expect(ping.id.length).toBeGreaterThan(0);
		expect(typeof ping.timestamp).toBe("number");
	});

	it("createPong echoes the ping's nonce", () => {
		const pong = createPong("nonce-xyz");
		expect(pong.type).toBe("pong");
		expect(pong.payload.nonce).toBe("nonce-xyz");
	});

	it("bye message carries the teardown reason", () => {
		const msg: ByeMessage = {
			type: "bye",
			id: "b-1",
			timestamp: Date.now(),
			payload: { reason: "exit" },
		};
		expect(msg.type).toBe("bye");
		expect(msg.payload.reason).toBe("exit");
	});

	it("message union includes bye", () => {
		const bye: Message = {
			type: "bye",
			id: "b-u",
			timestamp: 0,
			payload: { reason: "disconnect" },
		};
		expect(bye.type).toBe("bye");
	});

	it("createBye generates id and timestamp and echoes the reason", () => {
		const bye = createBye("disconnect");
		expect(bye.type).toBe("bye");
		expect(bye.payload.reason).toBe("disconnect");
		expect(typeof bye.id).toBe("string");
		expect(bye.id.length).toBeGreaterThan(0);
		expect(typeof bye.timestamp).toBe("number");
	});

	it("createBye supports the exit reason", () => {
		expect(createBye("exit").payload.reason).toBe("exit");
	});
});

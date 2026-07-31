import { describe, expect, it } from "bun:test";
import { decode, encode } from "../src/codec";
import type { PingMessage, PongMessage, TextMessage } from "../src/message";

describe("codec", () => {
	it("encodes and decodes a text message", () => {
		const original: TextMessage = {
			type: "text",
			id: "m1",
			timestamp: 123,
			payload: { text: "hello" },
		};
		const encoded = encode(original);
		const decoded = decode(encoded) as TextMessage;
		expect(decoded).toEqual(original);
	});

	it("encodes and decodes a ping message", () => {
		const original: PingMessage = {
			type: "ping",
			id: "p1",
			timestamp: 1,
			payload: { nonce: "abc" },
		};
		const encoded = encode(original);
		const decoded = decode(encoded) as PingMessage;
		expect(decoded).toEqual(original);
	});

	it("encodes and decodes a pong message", () => {
		const original: PongMessage = {
			type: "pong",
			id: "po1",
			timestamp: 2,
			payload: { nonce: "abc" },
		};
		const encoded = encode(original);
		const decoded = decode(encoded) as PongMessage;
		expect(decoded).toEqual(original);
	});

	it("throws on invalid json", () => {
		expect(() => decode(new Uint8Array([0xff]))).toThrow();
	});

	it("throws on unknown message type", () => {
		const invalid = new TextEncoder().encode(JSON.stringify({ type: "unknown", id: "x" }));
		expect(() => decode(invalid)).toThrow();
	});
});

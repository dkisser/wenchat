import { describe, expect, it } from "bun:test";
import { decode, encode } from "./codec";
import type { TextMessage } from "./message";

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

	it("throws on invalid json", () => {
		expect(() => decode(new Uint8Array([0xff]))).toThrow();
	});

	it("throws on unknown message type", () => {
		const invalid = new TextEncoder().encode(
			JSON.stringify({ type: "unknown", id: "x" }),
		);
		expect(() => decode(invalid)).toThrow();
	});
});

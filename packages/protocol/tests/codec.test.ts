import { describe, expect, it } from "bun:test";
import { decode, encode } from "../src/codec";
import { createFileAbort, createFileEnd, createFileStart } from "../src/file";
import type { PingMessage, PongMessage, TextMessage } from "../src/message";
import { createBye } from "../src/message";

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

	it("round-trips the file control messages", () => {
		const start = createFileStart("a.bin", 100, 64 * 1024, "tid");
		expect(decode(encode(start))).toEqual(start);

		const end = createFileEnd("tid", "sha256hex");
		expect(decode(encode(end))).toEqual(end);

		const abort = createFileAbort("tid", "boom");
		expect(decode(encode(abort))).toEqual(abort);
	});

	it("round-trips a bye message for both reasons", () => {
		const exit = createBye("exit", "b1");
		expect(decode(encode(exit))).toEqual(exit);

		const disconnect = createBye("disconnect", "b2");
		expect(decode(encode(disconnect))).toEqual(disconnect);
	});

	it("rejects a JSON file-chunk — chunks travel as binary frames", () => {
		const legacy = new TextEncoder().encode(
			JSON.stringify({
				type: "file-chunk",
				id: "x",
				timestamp: 1,
				payload: { transferId: "t", index: 0, data: [1, 2, 3] },
			}),
		);
		expect(() => decode(legacy)).toThrow("Unknown message type");
	});

	it("throws on invalid json", () => {
		expect(() => decode(new Uint8Array([0xff]))).toThrow();
	});

	it("throws on unknown message type", () => {
		const invalid = new TextEncoder().encode(JSON.stringify({ type: "unknown", id: "x" }));
		expect(() => decode(invalid)).toThrow();
	});
});

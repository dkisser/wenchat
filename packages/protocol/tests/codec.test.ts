import { describe, expect, it } from "bun:test";
import { decode, encode } from "../src/codec";
import { createFileAbort, createFileEnd, createFileStart } from "../src/file";
import {
	type FileChunkAckMessage,
	type MessageAckMessage,
	type PingMessage,
	type PongMessage,
	type TextMessage,
	createBye,
	createFileChunkAck,
	createMessageAck,
} from "../src/message";

describe("codec", () => {
	it("encodes and decodes a text message", () => {
		const original: TextMessage = {
			type: "text",
			id: "m1",
			timestamp: 123,
			seq: null,
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
			seq: null,
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
			seq: null,
			payload: { nonce: "abc" },
		};
		const encoded = encode(original);
		const decoded = decode(encoded) as PongMessage;
		expect(decoded).toEqual(original);
	});

	it("round-trips the file control messages", () => {
		const start = { ...createFileStart("a.bin", 100, 64 * 1024, "tid"), seq: null };
		expect(decode(encode(start))).toEqual(start);

		const end = { ...createFileEnd("tid", "sha256hex"), seq: null };
		expect(decode(encode(end))).toEqual(end);

		const abort = { ...createFileAbort("tid", "boom"), seq: null };
		expect(decode(encode(abort))).toEqual(abort);
	});

	it("round-trips a bye message for both reasons", () => {
		const exit = { ...createBye("exit", "b1"), seq: null };
		expect(decode(encode(exit))).toEqual(exit);

		const disconnect = { ...createBye("disconnect", "b2"), seq: null };
		expect(decode(encode(disconnect))).toEqual(disconnect);
	});

	it("round-trips a message-ack frame", () => {
		const original = createMessageAck(42, null, "ack-1");
		const decoded = decode(encode(original)) as MessageAckMessage;
		expect(decoded).toEqual(original);
		expect(decoded.type).toBe("message-ack");
		expect(decoded.payload.ack).toBe(42);
	});

	it("round-trips a file-chunk-ack frame and preserves the bitmap as a Uint8Array", () => {
		const bitmap = new Uint8Array([0b10101010, 0b00001111, 0b11110000, 0x00, 0xff]);
		const original = createFileChunkAck(
			"01234567-89ab-cdef-0123-456789abcdef",
			bitmap,
			39,
			null,
			"fca-1",
		);
		const decoded = decode(encode(original)) as FileChunkAckMessage;
		expect(decoded).toEqual(original);
		expect(decoded.type).toBe("file-chunk-ack");
		expect(decoded.payload.bitmap).toBeInstanceOf(Uint8Array);
		expect(decoded.payload.bitmap.byteLength).toBe(bitmap.byteLength);
		expect(Array.from(decoded.payload.bitmap)).toEqual(Array.from(bitmap));
		expect(decoded.payload.lastIndex).toBe(39);
	});

	it("round-trips a file-chunk-ack with an empty bitmap", () => {
		const original = createFileChunkAck("tid", new Uint8Array(0), 0, null, "fca-empty");
		const decoded = decode(encode(original)) as FileChunkAckMessage;
		expect(decoded).toEqual(original);
		expect(decoded.payload.bitmap.byteLength).toBe(0);
	});

	it("preserves seq=0 on a text message", () => {
		const original: TextMessage = {
			type: "text",
			id: "m0",
			timestamp: 0,
			seq: 0,
			payload: { text: "zero" },
		};
		const decoded = decode(encode(original)) as TextMessage;
		expect(decoded.seq).toBe(0);
		expect(decoded).toEqual(original);
	});

	it("preserves seq=Number.MAX_SAFE_INTEGER on a text message", () => {
		const original: TextMessage = {
			type: "text",
			id: "mmax",
			timestamp: 0,
			seq: Number.MAX_SAFE_INTEGER,
			payload: { text: "max" },
		};
		const decoded = decode(encode(original)) as TextMessage;
		expect(decoded.seq).toBe(Number.MAX_SAFE_INTEGER);
		expect(decoded).toEqual(original);
	});

	it("preserves an arbitrary large-but-safe seq value", () => {
		const seq = 1_000_000_000_000_000; // 1e15, well within MAX_SAFE_INTEGER
		const original: TextMessage = {
			type: "text",
			id: "mbig",
			timestamp: 0,
			seq,
			payload: { text: "big" },
		};
		const decoded = decode(encode(original)) as TextMessage;
		expect(decoded.seq).toBe(seq);
	});

	it("decodes missing seq as null (ADR 0003 Q11 legacy compat)", () => {
		const legacy = new TextEncoder().encode(
			JSON.stringify({
				type: "text",
				id: "legacy",
				timestamp: 0,
				payload: { text: "no seq field on the wire" },
			}),
		);
		const decoded = decode(legacy) as TextMessage;
		expect(decoded.seq).toBeNull();
	});

	it("preserves explicit seq=null on a text message", () => {
		const original: TextMessage = {
			type: "text",
			id: "nullseq",
			timestamp: 0,
			seq: null,
			payload: { text: "explicit null" },
		};
		const decoded = decode(encode(original)) as TextMessage;
		expect(decoded.seq).toBeNull();
		expect(decoded).toEqual(original);
	});

	it("rejects seq < 0", () => {
		const bad = new TextEncoder().encode(
			JSON.stringify({
				type: "text",
				id: "neg",
				timestamp: 0,
				seq: -1,
				payload: { text: "x" },
			}),
		);
		expect(() => decode(bad)).toThrow(/seq/i);
	});

	it("rejects seq above Number.MAX_SAFE_INTEGER", () => {
		const bad = new TextEncoder().encode(
			JSON.stringify({
				type: "text",
				id: "huge",
				timestamp: 0,
				seq: Number.MAX_SAFE_INTEGER + 100,
				payload: { text: "x" },
			}),
		);
		expect(() => decode(bad)).toThrow(/seq/i);
	});

	it("rejects non-numeric seq", () => {
		const bad = new TextEncoder().encode(
			JSON.stringify({
				type: "text",
				id: "str",
				timestamp: 0,
				seq: "1",
				payload: { text: "x" },
			}),
		);
		expect(() => decode(bad)).toThrow(/seq/i);
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

	it("throws when decoded value is not an object", () => {
		expect(() => decode(new TextEncoder().encode("42"))).toThrow("not an object");
		expect(() => decode(new TextEncoder().encode("null"))).toThrow("not an object");
	});

	it("throws on unknown message type", () => {
		const invalid = new TextEncoder().encode(JSON.stringify({ type: "unknown", id: "x" }));
		expect(() => decode(invalid)).toThrow();
	});

	it("throws when file-chunk-ack payload is missing or not an object", () => {
		const missingPayload = new TextEncoder().encode(
			JSON.stringify({ type: "file-chunk-ack", id: "x", timestamp: 0, seq: 1 }),
		);
		expect(() => decode(missingPayload)).toThrow(/payload/);
	});

	it("throws when file-chunk-ack transferId is not a string", () => {
		const bad = new TextEncoder().encode(
			JSON.stringify({
				type: "file-chunk-ack",
				id: "x",
				timestamp: 0,
				seq: 1,
				payload: { transferId: 7, bitmap: "AA==", lastIndex: 0 },
			}),
		);
		expect(() => decode(bad)).toThrow(/transferId/);
	});

	it("throws when file-chunk-ack bitmap is not a base64 string", () => {
		const bad = new TextEncoder().encode(
			JSON.stringify({
				type: "file-chunk-ack",
				id: "x",
				timestamp: 0,
				seq: 1,
				payload: { transferId: "tid", bitmap: [0xff], lastIndex: 0 },
			}),
		);
		expect(() => decode(bad)).toThrow(/bitmap/);
	});

	it("throws when file-chunk-ack lastIndex is not a non-negative integer", () => {
		const bad = new TextEncoder().encode(
			JSON.stringify({
				type: "file-chunk-ack",
				id: "x",
				timestamp: 0,
				seq: 1,
				payload: { transferId: "tid", bitmap: "AA==", lastIndex: -1 },
			}),
		);
		expect(() => decode(bad)).toThrow(/lastIndex/);
	});
});

import { describe, expect, it } from "bun:test";
import { type Message, decodeWirePacket, encode, encodeFileChunkFrame } from "../src/index";

const TRANSFER_ID = "01234567-89ab-cdef-0123-456789abcdef";

describe("decodeWirePacket", () => {
	it("demuxes a JSON datagram to a message", () => {
		const message: Message = {
			type: "text",
			id: "m1",
			timestamp: 42,
			payload: { text: "hello" },
		};
		const packet = decodeWirePacket(encode(message));
		expect(packet.kind).toBe("message");
		if (packet.kind !== "message") throw new Error("unreachable");
		expect(packet.message).toEqual(message);
	});

	it("accepts a string datagram (werift may surface text as string)", () => {
		const message: Message = { type: "ping", id: "p1", timestamp: 0, payload: { nonce: "n" } };
		const packet = decodeWirePacket(JSON.stringify(message));
		expect(packet.kind).toBe("message");
		if (packet.kind !== "message") throw new Error("unreachable");
		expect(packet.message).toEqual(message);
	});

	it("demuxes a binary frame to a raw chunk — no synthesized id/timestamp", () => {
		const payload = new Uint8Array([9, 8, 7]);
		const packet = decodeWirePacket(encodeFileChunkFrame(TRANSFER_ID, 3, payload));
		expect(packet.kind).toBe("file-chunk");
		if (packet.kind !== "file-chunk") throw new Error("unreachable");
		expect(packet.chunk.transferId).toBe(TRANSFER_ID);
		expect(packet.chunk.index).toBe(3);
		expect(new Uint8Array(packet.chunk.data)).toEqual(payload);
		// The chunk shape carries exactly the frame header fields — nothing
		// the wire never sent.
		expect(Object.keys(packet.chunk).sort()).toEqual(["data", "index", "transferId"]);
	});

	it("throws on a datagram that is neither JSON message nor chunk frame", () => {
		expect(() => decodeWirePacket(new Uint8Array([0xff, 0x00, 0x01]))).toThrow();
	});

	it("throws on a JSON file-chunk — chunks never travel as JSON", () => {
		const fake = JSON.stringify({
			type: "file-chunk",
			id: "x",
			timestamp: 0,
			payload: { transferId: TRANSFER_ID, index: 0, data: [] },
		});
		expect(() => decodeWirePacket(fake)).toThrow("Unknown message type");
	});
});

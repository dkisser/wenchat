import { describe, expect, it } from "bun:test";
import {
	type ByeMessage,
	type FileChunkAckMessage,
	type Message,
	type MessageAckMessage,
	type PingMessage,
	type PongMessage,
	type Seq,
	type TextMessage,
	createBye,
	createFileChunkAck,
	createMessageAck,
	createPing,
	createPong,
} from "../src/message";

describe("message types", () => {
	it("text message has required fields", () => {
		const msg: TextMessage = {
			type: "text",
			id: "msg-1",
			timestamp: Date.now(),
			seq: null,
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
			seq: null,
			payload: { text: "hi" },
		};
		expect(msg.type).toBe("text");
	});

	it("ping message carries nonce", () => {
		const msg: PingMessage = {
			type: "ping",
			id: "p-1",
			timestamp: Date.now(),
			seq: null,
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
			seq: null,
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
			seq: null,
			payload: { nonce: "n1" },
		};
		const pong: Message = {
			type: "pong",
			id: "po-u",
			timestamp: 0,
			seq: null,
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
			seq: null,
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
			seq: null,
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

describe("ack frames (Stage 1, ADR 0003 Q2)", () => {
	it("message-ack carries ack payload", () => {
		const msg: MessageAckMessage = {
			type: "message-ack",
			id: "a1",
			timestamp: 1,
			seq: null,
			payload: { ack: 100 },
		};
		expect(msg.type).toBe("message-ack");
		expect(msg.payload.ack).toBe(100);
	});

	it("file-chunk-ack carries transferId, bitmap Uint8Array, and lastIndex", () => {
		const bitmap = new Uint8Array([0xff, 0x00, 0xaa]);
		const msg: FileChunkAckMessage = {
			type: "file-chunk-ack",
			id: "f1",
			timestamp: 1,
			seq: null,
			payload: {
				transferId: "tid",
				bitmap,
				lastIndex: 23,
			},
		};
		expect(msg.type).toBe("file-chunk-ack");
		expect(msg.payload.transferId).toBe("tid");
		expect(msg.payload.bitmap).toBeInstanceOf(Uint8Array);
		expect(msg.payload.lastIndex).toBe(23);
	});

	it("Message union accepts message-ack and file-chunk-ack variants", () => {
		const m: Message = {
			type: "message-ack",
			id: "x",
			timestamp: 0,
			seq: 1,
			payload: { ack: 1 },
		};
		const f: Message = {
			type: "file-chunk-ack",
			id: "y",
			timestamp: 0,
			seq: 1,
			payload: {
				transferId: "t",
				bitmap: new Uint8Array(0),
				lastIndex: 0,
			},
		};
		expect(m.type).toBe("message-ack");
		expect(f.type).toBe("file-chunk-ack");
	});

	it("createMessageAck generates id and timestamp and echoes ack", () => {
		const ack = createMessageAck(42);
		expect(ack.type).toBe("message-ack");
		expect(ack.payload.ack).toBe(42);
		expect(typeof ack.id).toBe("string");
		expect(ack.id.length).toBeGreaterThan(0);
		expect(typeof ack.timestamp).toBe("number");
		expect(ack.seq).toBeNull();
	});

	it("createFileChunkAck generates id and timestamp and echoes args", () => {
		const bitmap = new Uint8Array([1, 2, 3]);
		const ack = createFileChunkAck("tid", bitmap, 7);
		expect(ack.type).toBe("file-chunk-ack");
		expect(ack.payload.transferId).toBe("tid");
		expect(Array.from(ack.payload.bitmap)).toEqual([1, 2, 3]);
		expect(ack.payload.lastIndex).toBe(7);
		expect(ack.seq).toBeNull();
	});

	it("Seq type is number or null", () => {
		const a: Seq = 5;
		const b: Seq = null;
		expect(typeof a).toBe("number");
		expect(b).toBeNull();
	});
});

describe("seq preservation through JSON (Stage 1, ADR 0003 Q1, Q11)", () => {
	const variants: ReadonlyArray<{ name: string; build: (seq: number) => unknown }> = [
		{
			name: "text",
			build: (seq) => ({
				type: "text",
				id: "t",
				timestamp: 0,
				seq,
				payload: { text: "hi" },
			}),
		},
		{
			name: "file-start",
			build: (seq) => ({
				type: "file-start",
				id: "t",
				timestamp: 0,
				seq,
				payload: { transferId: "tid", fileName: "f", fileSize: 1, chunkSize: 1 },
			}),
		},
		{
			name: "file-end",
			build: (seq) => ({
				type: "file-end",
				id: "t",
				timestamp: 0,
				seq,
				payload: { transferId: "tid", checksum: "sha" },
			}),
		},
		{
			name: "file-abort",
			build: (seq) => ({
				type: "file-abort",
				id: "t",
				timestamp: 0,
				seq,
				payload: { transferId: "tid", reason: "r" },
			}),
		},
		{
			name: "ping",
			build: (seq) => ({
				type: "ping",
				id: "t",
				timestamp: 0,
				seq,
				payload: { nonce: "n" },
			}),
		},
		{
			name: "pong",
			build: (seq) => ({
				type: "pong",
				id: "t",
				timestamp: 0,
				seq,
				payload: { nonce: "n" },
			}),
		},
		{
			name: "bye",
			build: (seq) => ({
				type: "bye",
				id: "t",
				timestamp: 0,
				seq,
				payload: { reason: "exit" },
			}),
		},
		{
			name: "message-ack",
			build: (seq) => ({
				type: "message-ack",
				id: "t",
				timestamp: 0,
				seq,
				payload: { ack: 7 },
			}),
		},
	];

	for (const { name, build } of variants) {
		it(`${name} variant keeps seq through JSON.stringify/parse`, () => {
			const seq = 12345;
			const original = build(seq) as { seq: unknown };
			const round = JSON.parse(JSON.stringify(original)) as { seq: unknown };
			expect(round.seq).toBe(seq);
		});
	}
});

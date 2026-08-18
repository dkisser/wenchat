import { describe, expect, it } from "bun:test";
import { encodeFileChunkFrame } from "@wenchat/protocol";
import { DataTransport } from "../../src/transport";

const TRANSFER_ID = "01234567-89ab-cdef-0123-456789abcdef";

function makeFakeChannel() {
	const lowListeners = new Set<() => void>();
	return {
		sent: [] as Uint8Array[],
		readyState: "open",
		bufferedAmount: 0,
		bufferedAmountLowThreshold: 0,
		bufferedAmountLow: {
			subscribe: (cb: () => void) => {
				lowListeners.add(cb);
				return { unSubscribe: () => lowListeners.delete(cb) };
			},
		},
		fireBufferedAmountLow() {
			for (const cb of [...lowListeners]) cb();
		},
		onmessage: null as ((event: { data: unknown }) => void) | null,
		onclose: null as (() => void) | null,
		send(buf: Uint8Array) {
			this.sent.push(buf);
		},
		close() {
			this.readyState = "closed";
			this.onclose?.();
		},
	};
}

describe("DataTransport", () => {
	it("wraps a channel and forwards decoded messages", () => {
		const messages: unknown[] = [];
		const fakeChannel = makeFakeChannel();

		const transport = new DataTransport(fakeChannel as never);
		transport.onMessage((msg) => messages.push(msg));

		const encoded = new TextEncoder().encode(
			JSON.stringify({ type: "text", id: "1", timestamp: 0, payload: { text: "hi" } }),
		);
		fakeChannel.onmessage?.({ data: encoded });

		expect(messages.length).toBe(1);
		expect((messages[0] as { payload: { text: string } }).payload.text).toBe("hi");
	});

	it("synthesizes a file-chunk message from a binary frame", () => {
		const messages: unknown[] = [];
		const fakeChannel = makeFakeChannel();
		const transport = new DataTransport(fakeChannel as never);
		transport.onMessage((msg) => messages.push(msg));

		const payload = new Uint8Array([9, 8, 7]);
		fakeChannel.onmessage?.({ data: encodeFileChunkFrame(TRANSFER_ID, 3, payload) });

		expect(messages.length).toBe(1);
		const message = messages[0] as {
			type: string;
			payload: { transferId: string; index: number; data: Uint8Array };
		};
		expect(message.type).toBe("file-chunk");
		expect(message.payload.transferId).toBe(TRANSFER_ID);
		expect(message.payload.index).toBe(3);
		expect(new Uint8Array(message.payload.data)).toEqual(payload);
	});

	it("drops undecodable messages instead of throwing into the emitter", () => {
		const messages: unknown[] = [];
		const fakeChannel = makeFakeChannel();
		const transport = new DataTransport(fakeChannel as never);
		transport.onMessage((msg) => messages.push(msg));

		// Not a binary frame (wrong magic) and not valid JSON either.
		expect(() =>
			fakeChannel.onmessage?.({ data: new Uint8Array([0xff, 0x00, 0x01]) }),
		).not.toThrow();
		expect(messages.length).toBe(0);
	});

	it("a throwing message listener does not starve the rest of the fan-out", () => {
		const received: unknown[] = [];
		const fakeChannel = makeFakeChannel();
		const transport = new DataTransport(fakeChannel as never);
		transport.onMessage(() => {
			throw new Error("listener bug");
		});
		transport.onMessage((msg) => received.push(msg));

		const encoded = new TextEncoder().encode(
			JSON.stringify({ type: "text", id: "1", timestamp: 0, payload: { text: "hi" } }),
		);
		// The throw must be contained — not propagated into the emitter,
		// and not skipping the second listener.
		expect(() => fakeChannel.onmessage?.({ data: encoded })).not.toThrow();
		expect(received.length).toBe(1);
	});

	it("a throwing close listener does not starve the rest of the fan-out", () => {
		const fakeChannel = makeFakeChannel();
		const transport = new DataTransport(fakeChannel as never);
		let closes = 0;
		transport.onClose(() => {
			throw new Error("listener bug");
		});
		transport.onClose(() => {
			closes++;
		});

		expect(() => fakeChannel.close()).not.toThrow();
		expect(closes).toBe(1);
	});

	it("sendBinary writes the frame verbatim", () => {
		const fakeChannel = makeFakeChannel();
		const transport = new DataTransport(fakeChannel as never);
		const frame = encodeFileChunkFrame(TRANSFER_ID, 0, new Uint8Array([1, 2]));
		transport.sendBinary(frame);
		expect(fakeChannel.sent.length).toBe(1);
		expect(new Uint8Array(fakeChannel.sent[0] as Uint8Array)).toEqual(frame);
	});

	it("notifies onClose exactly once, including on repeated closes", () => {
		const fakeChannel = makeFakeChannel();
		const transport = new DataTransport(fakeChannel as never);
		let closes = 0;
		transport.onClose(() => {
			closes++;
		});
		fakeChannel.close();
		fakeChannel.close();
		expect(closes).toBe(1);
	});

	it("waitForDrain resolves once the buffer drops under the threshold", async () => {
		const fakeChannel = makeFakeChannel();
		fakeChannel.bufferedAmount = 1000;
		const transport = new DataTransport(fakeChannel as never);

		let resolved = false;
		const wait = transport.waitForDrain(100, 5).then(() => {
			resolved = true;
		});
		// Let the wait install its listeners, then drain the queue.
		await new Promise((resolve) => setTimeout(resolve, 10));
		fakeChannel.bufferedAmount = 50;
		fakeChannel.fireBufferedAmountLow();
		await wait;

		expect(resolved).toBe(true);
		expect(fakeChannel.bufferedAmountLowThreshold).toBe(100);
	});

	it("waitForDrain rejects when the channel closes while waiting", async () => {
		const fakeChannel = makeFakeChannel();
		fakeChannel.bufferedAmount = 1000;
		const transport = new DataTransport(fakeChannel as never);

		const wait = transport.waitForDrain(100, 5);
		await new Promise((resolve) => setTimeout(resolve, 10));
		fakeChannel.close();

		await expect(wait).rejects.toThrow("closed");
	});
});

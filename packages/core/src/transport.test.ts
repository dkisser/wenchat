import { describe, expect, it } from "bun:test";
import { DataTransport } from "./transport";

describe("DataTransport", () => {
	it("wraps a channel and forwards decoded messages", () => {
		const messages: unknown[] = [];
		const fakeChannel = {
			send: () => {},
			onmessage: null as ((event: { data: Uint8Array }) => void) | null,
		};

		const transport = new DataTransport(fakeChannel as never);
		transport.onMessage((msg) => messages.push(msg));

		const encoded = new TextEncoder().encode(
			JSON.stringify({ type: "text", id: "1", timestamp: 0, payload: { text: "hi" } }),
		);
		fakeChannel.onmessage?.({ data: encoded });

		expect(messages.length).toBe(1);
		expect((messages[0] as { payload: { text: string } }).payload.text).toBe("hi");
	});
});

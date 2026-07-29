import { describe, expect, it } from "bun:test";
import type { Message, TextMessage } from "./message";

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
});

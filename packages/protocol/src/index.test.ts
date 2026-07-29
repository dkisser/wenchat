import { describe, expect, it } from "bun:test";
import { computeChecksum, decode, encode } from "./index.ts";
import type { TextMessage } from "./index.ts";

describe("index exports", () => {
	it("exports codec and file helpers", () => {
		const msg: TextMessage = {
			type: "text",
			id: "i1",
			timestamp: 0,
			payload: { text: "hi" },
		};
		expect(decode(encode(msg))).toEqual(msg);
		expect(typeof computeChecksum).toBe("function");
	});
});

import { describe, expect, it } from "bun:test";
import {
	createFileStart,
	decode,
	decodeFileChunkFrame,
	encode,
	encodeFileChunkFrame,
} from "../src/index";
import type { TextMessage } from "../src/index";

describe("index exports", () => {
	it("exports codec and file helpers", () => {
		const msg: TextMessage = {
			type: "text",
			id: "i1",
			timestamp: 0,
			payload: { text: "hi" },
		};
		expect(decode(encode(msg))).toEqual(msg);
		expect(typeof createFileStart).toBe("function");
	});

	it("exports the binary frame helpers", () => {
		const frame = encodeFileChunkFrame(
			"01234567-89ab-cdef-0123-456789abcdef",
			0,
			new Uint8Array([1]),
		);
		expect(decodeFileChunkFrame(frame).index).toBe(0);
	});
});

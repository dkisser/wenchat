import { describe, expect, it } from "bun:test";
import type { Message } from "@wenchat/protocol";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { formatMessage, sliceViewport, toDisplayLines, wrapToWidth } from "../../src/displayLines";

function text(id: string, body: string): Message {
	return { type: "text", id, timestamp: 0, payload: { text: body } };
}

describe("formatMessage", () => {
	it("prefixes own messages with [me]", () => {
		expect(formatMessage(text("local-1", "hi"), "local")).toBe("[me] hi");
	});

	it("prefixes remote messages with [peer]", () => {
		expect(formatMessage(text("remote-1", "hi"), "local")).toBe("[peer] hi");
	});

	it("prefixes system entries with [system] even when localId would also match", () => {
		// The CLI mints system ids as `system-${uuid}`; the check has to run
		// before the local/peer prefix test or a peer UUID could shadow it.
		expect(formatMessage(text("system-abc", "Connected"), "system")).toBe("[system] Connected");
	});

	it("summarises a file-start message", () => {
		const message: Message = {
			type: "file-start",
			id: "local-1",
			timestamp: 0,
			payload: {
				transferId: "t",
				fileName: "a.txt",
				fileSize: 1,
				chunkSize: 1,
				checksum: "abc",
			},
		};
		expect(formatMessage(message, "local")).toBe("[me] sending file: a.txt");
	});
});

describe("wrapToWidth", () => {
	it("returns a single line when the text fits", () => {
		expect(wrapToWidth("hello", 10)).toEqual(["hello"]);
	});

	it("keeps an empty string as one (empty) line", () => {
		expect(wrapToWidth("", 10)).toEqual([""]);
	});

	it("hard-wraps a word longer than the width", () => {
		expect(wrapToWidth("abcdefghijkl", 5)).toEqual(["abcde", "fghij", "kl"]);
	});

	it("counts CJK characters as two columns wide", () => {
		expect(wrapToWidth("你好世界这是一段很长的中文消息", 16)).toEqual([
			"你好世界这是一段",
			"很长的中文消息",
		]);
	});

	it("survives a non-positive width instead of looping forever", () => {
		expect(wrapToWidth("hi", 0).length).toBeGreaterThan(0);
		expect(wrapToWidth("hi", -5).length).toBeGreaterThan(0);
	});

	// Load-bearing invariant: our line count must equal the line count ink
	// will actually draw, or the frame height drifts and the InputBox gets
	// pushed off screen again. ink wraps via wrapAnsi(text, w, {trim: false,
	// hard: true}) in ink/build/wrap-text.js — we call the identical thing.
	// If an ink upgrade changes those options, this test goes red instead of
	// the layout silently breaking.
	it("matches how ink itself wraps the same text at the same width", () => {
		const body = "你好世界这是一段很长的中文消息 mixed with some english words here";
		const { lastFrame } = render(
			<Box width={20} borderStyle="single" paddingX={1}>
				<Text>{body}</Text>
			</Box>,
		);
		const frame = lastFrame() ?? "";
		const inner = frame
			.split("\n")
			.slice(1, -1)
			.map((line) => line.slice(1, -1).slice(1, -1).trimEnd());

		expect(inner).toEqual(wrapToWidth(body, 16).map((line) => line.trimEnd()));
	});
});

describe("toDisplayLines", () => {
	it("returns no lines for no messages", () => {
		expect(toDisplayLines([], "local", 40)).toEqual([]);
	});

	it("preserves message order", () => {
		const lines = toDisplayLines([text("local-1", "one"), text("r-2", "two")], "local", 40);
		expect(lines).toEqual(["[me] one", "[peer] two"]);
	});

	it("expands into as many lines as each message wraps to", () => {
		const messages = [text("local-1", "abcdefghij"), text("local-2", "x")];
		// "[me] abcdefghij" is 15 cols → 3 lines at width 6; "[me] x" → 1 line.
		expect(toDisplayLines(messages, "local", 6).length).toBe(
			wrapToWidth("[me] abcdefghij", 6).length + 1,
		);
	});
});

describe("sliceViewport", () => {
	const lines = ["a", "b", "c", "d", "e"];

	it("takes a window starting at topLine", () => {
		expect(sliceViewport(lines, 1, 3)).toEqual(["b", "c", "d"]);
	});

	it("clamps a negative topLine to the start", () => {
		expect(sliceViewport(lines, -3, 2)).toEqual(["a", "b"]);
	});

	it("returns nothing when topLine is past the end", () => {
		expect(sliceViewport(lines, 99, 3)).toEqual([]);
	});

	it("returns everything when the height exceeds the line count", () => {
		expect(sliceViewport(lines, 0, 99)).toEqual(lines);
	});

	it("returns nothing for a non-positive height", () => {
		expect(sliceViewport(lines, 0, 0)).toEqual([]);
	});
});

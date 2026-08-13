import { describe, expect, it } from "bun:test";
import type { Message } from "@wenchat/protocol";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import {
	findMessageAtLine,
	formatMessage,
	sliceViewport,
	toDisplayLines,
	wrapToWidth,
} from "../../src/displayLines";

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

	it("renders markdown in user messages", () => {
		// me/peer messages go through the renderer so bold/italic/etc. show.
		expect(formatMessage(text("local-1", "**bold**"), "local")).toContain("\x1b[1m");
		expect(formatMessage(text("remote-1", "**bold**"), "local")).toContain("\x1b[1m");
	});

	it("leaves system messages verbatim — no markdown parsing", () => {
		// A future "Connected to https://x.y" must not become a hyperlink,
		// and "**notice**" must not become bold.
		const out = formatMessage(text("system-1", "Connected to https://x.y"), "system");
		expect(out).toBe("[system] Connected to https://x.y");
		expect(out).not.toContain("\x1b[");
	});

	it("preserves newlines from peer messages across formatMessage", () => {
		// The flattening into a single string is what previously ate
		// newlines; the renderer must keep them intact for wrap-ansi.
		const out = formatMessage(text("remote-1", "line one\nline two"), "local");
		expect(out).toBe("[system] line one\nline two".replace("[system]", "[peer]"));
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
		const result = toDisplayLines([], "local", 40);
		expect(result.lines).toEqual([]);
		expect(result.messageStartIndices).toEqual([]);
	});

	it("preserves message order", () => {
		const result = toDisplayLines([text("local-1", "one"), text("r-2", "two")], "local", 40);
		expect(result.lines).toEqual(["[me] one", "[peer] two"]);
	});

	it("expands into as many lines as each message wraps to", () => {
		const messages = [text("local-1", "abcdefghij"), text("local-2", "x")];
		// "[me] abcdefghij" is 15 cols → 3 lines at width 6; "[me] x" → 1 line.
		expect(toDisplayLines(messages, "local", 6).lines.length).toBe(
			wrapToWidth("[me] abcdefghij", 6).length + 1,
		);
	});

	it("records each message's starting line index", () => {
		// First message wraps to 3 lines, second message starts at line 3.
		const messages = [text("local-1", "abcdef"), text("r-2", "ghi")];
		const result = toDisplayLines(messages, "local", 4);
		// "[me] abcdef" at width 4 → 3 lines: "[me]", " abc", "def".
		expect(result.messageStartIndices).toEqual([0, 3]);
		expect(result.messageStartIndices.length).toBe(messages.length);
	});
});

describe("findMessageAtLine", () => {
	it("returns -1 for empty start indices", () => {
		expect(findMessageAtLine([], 0)).toBe(-1);
	});

	it("maps each line back to its owning message", () => {
		// Messages 0 and 1 each take 2 lines; message 2 takes 1 line.
		// Layout: [0, 1] [2, 3] [4]
		const starts = [0, 2, 4];
		expect(findMessageAtLine(starts, 0)).toBe(0);
		expect(findMessageAtLine(starts, 1)).toBe(0);
		expect(findMessageAtLine(starts, 2)).toBe(1);
		expect(findMessageAtLine(starts, 3)).toBe(1);
		expect(findMessageAtLine(starts, 4)).toBe(2);
	});

	it("returns -1 for a line before the first message", () => {
		expect(findMessageAtLine([2, 5], 1)).toBe(-1);
	});

	it("handles a single-message list", () => {
		expect(findMessageAtLine([0], 0)).toBe(0);
		expect(findMessageAtLine([0], 99)).toBe(0);
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

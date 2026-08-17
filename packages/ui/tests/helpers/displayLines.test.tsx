import { describe, expect, it } from "bun:test";
import type { Message } from "@wenchat/protocol";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import {
	type ChatNames,
	findMessageAtLine,
	formatMessage,
	formatTimestamp,
	sliceViewport,
	toDisplayLines,
	wrapToWidth,
} from "../../src/displayLines";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping SGR escapes requires matching ESC
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Local name "alice" (5 cols) vs fallback peer name "peer" (4) → nameWidth 5. */
const NAMES: ChatNames = { local: "alice" };
/** prefixWidth = 5 (HH:mm) + 2 + 5 (name column) + 2. */
const PREFIX_WIDTH = 14;

function text(id: string, body: string): Message {
	return { type: "text", id, timestamp: 0, payload: { text: body } };
}

describe("formatMessage", () => {
	it("styles own messages with a dim timestamp and a cyan bold nickname", () => {
		const out = formatMessage(text("local-1", "hi"), "local", NAMES);
		expect(out.system).toBe(false);
		expect(stripAnsi(out.prefix)).toBe(`${formatTimestamp(0)}  alice  `);
		expect(out.prefix).toContain("\x1b[90m");
		expect(out.prefix).toContain("\x1b[36m");
		expect(out.prefixWidth).toBe(PREFIX_WIDTH);
		expect(out.body).toBe("hi");
	});

	it("styles peer messages with a magenta nickname padded to the name column", () => {
		const out = formatMessage(text("remote-1", "hi"), "local", NAMES);
		expect(out.system).toBe(false);
		// "peer" + 1 pad space (to match "alice") + 2 separator spaces.
		expect(stripAnsi(out.prefix)).toBe(`${formatTimestamp(0)}  peer   `);
		expect(out.prefix).toContain("\x1b[35m");
		expect(out.prefixWidth).toBe(PREFIX_WIDTH);
	});

	it("marks system entries as system even when localId would also match", () => {
		// The CLI mints system ids as `system-${uuid}`; the check has to run
		// before the local/peer prefix test or a peer UUID could shadow it.
		const out = formatMessage(text("system-abc", "Connected"), "system", NAMES);
		expect(out.system).toBe(true);
		expect(out.prefix).toBe("");
		expect(out.prefixWidth).toBe(0);
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
		const out = formatMessage(message, "local", NAMES);
		expect(out.system).toBe(false);
		expect(out.body).toBe("sending file: a.txt");
	});

	it("renders markdown in user message bodies", () => {
		// me/peer messages go through the renderer so bold/italic/etc. show.
		expect(formatMessage(text("local-1", "**bold**"), "local", NAMES).body).toContain("\x1b[1m");
		expect(formatMessage(text("remote-1", "**bold**"), "local", NAMES).body).toContain("\x1b[1m");
	});

	it("dims system messages but never markdown-parses them", () => {
		// A future "Connected to https://x.y" must not become a hyperlink,
		// and "**notice**" must not become bold.
		const out = formatMessage(text("system-1", "Connected to https://x.y"), "system", NAMES);
		expect(out.body).toContain("\x1b[90m");
		expect(out.body).not.toContain("\x1b[1m");
		expect(stripAnsi(out.body)).toBe("Connected to https://x.y");
	});

	it("falls back to generic names when nicknames are unknown", () => {
		const mine = formatMessage(text("local-1", "hi"), "local", { local: "" });
		expect(stripAnsi(mine.prefix)).toBe(`${formatTimestamp(0)}  me    `);
		const theirs = formatMessage(text("r-1", "hi"), "local", { local: "" });
		// nameWidth = max("me", "peer") = 4 → "peer" needs no pad.
		expect(stripAnsi(theirs.prefix)).toBe(`${formatTimestamp(0)}  peer  `);
	});

	it("measures CJK nicknames as two columns when padding the name column", () => {
		// "阿黄" is 4 columns wide, so "ab" needs two pad spaces to align.
		const out = formatMessage(text("r-1", "hi"), "local", { local: "阿黄", peer: "ab" });
		expect(stripAnsi(out.prefix)).toBe(`${formatTimestamp(0)}  ab    `);
		expect(out.prefixWidth).toBe(5 + 2 + 4 + 2);
	});

	it("preserves newlines from peer messages in the body", () => {
		// The flattening into a single string is what previously ate
		// newlines; the renderer must keep them intact for wrap-ansi.
		const out = formatMessage(text("remote-1", "line one\nline two"), "local", NAMES);
		expect(stripAnsi(out.body)).toBe("line one\nline two");
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
		const result = toDisplayLines([], "local", NAMES, 40);
		expect(result.lines).toEqual([]);
		expect(result.messageStartIndices).toEqual([]);
	});

	it("preserves message order", () => {
		const result = toDisplayLines([text("local-1", "one"), text("r-2", "two")], "local", NAMES, 40);
		expect(result.lines.map(stripAnsi)).toEqual([
			`${formatTimestamp(0)}  alice  one`,
			`${formatTimestamp(0)}  peer   two`,
		]);
	});

	it("indents soft-wrapped continuation lines to the body column", () => {
		// prefixWidth 14, contentWidth 18 → body wraps at 4 columns.
		const result = toDisplayLines([text("local-1", "abcdefgh")], "local", NAMES, 18);
		expect(result.lines.map(stripAnsi)).toEqual([
			`${formatTimestamp(0)}  alice  abcd`,
			`${" ".repeat(PREFIX_WIDTH)}efgh`,
		]);
	});

	it("indents embedded newlines to the body column too", () => {
		const result = toDisplayLines([text("local-1", "ab\ncd")], "local", NAMES, 40);
		expect(result.lines.map(stripAnsi)).toEqual([
			`${formatTimestamp(0)}  alice  ab`,
			`${" ".repeat(PREFIX_WIDTH)}cd`,
		]);
	});

	it("records each message's starting line index", () => {
		// First message's body wraps to 2 lines, second message starts at line 2.
		const messages = [text("local-1", "abcdef"), text("r-2", "ghi")];
		const result = toDisplayLines(messages, "local", NAMES, 18);
		expect(result.messageStartIndices).toEqual([0, 2]);
		expect(result.messageStartIndices.length).toBe(messages.length);
	});

	it("separates a system message from the previous one with a blank line it owns", () => {
		const messages = [text("local-1", "hi"), text("system-2", "Connected")];
		const result = toDisplayLines(messages, "local", NAMES, 40);
		// The separator belongs to the system message's block, so its start
		// index points at the blank line and double-click still resolves.
		expect(result.messageStartIndices).toEqual([0, 1]);
		expect(result.lines[1]).toBe(" ");
		expect(stripAnsi(result.lines[2] ?? "")).toBe("Connected");
	});

	it("does not lead with a blank line when the first message is a system entry", () => {
		const result = toDisplayLines([text("system-1", "Connected")], "local", NAMES, 40);
		expect(result.messageStartIndices).toEqual([0]);
		expect(stripAnsi(result.lines[0] ?? "")).toBe("Connected");
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

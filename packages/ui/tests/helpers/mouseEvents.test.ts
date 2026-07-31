import { describe, expect, it } from "bun:test";
import {
	MAX_PENDING_BYTES,
	containsMouseReport,
	parseMouseChunk,
	stripMouseReports,
} from "../../src/mouseEvents";

const ESC = "\u001B";
const wheelUp = `${ESC}[<64;10;5M`;
const wheelDown = `${ESC}[<65;10;5M`;

describe("parseMouseChunk", () => {
	it("decodes a wheel-up report", () => {
		const { events, rest } = parseMouseChunk(wheelUp);
		expect(rest).toBe("");
		expect(events).toEqual([
			{
				button: "wheel-up",
				buttonCode: 64,
				column: 10,
				row: 5,
				release: false,
				shift: false,
				alt: false,
				ctrl: false,
			},
		]);
	});

	it("decodes a wheel-down report", () => {
		expect(parseMouseChunk(wheelDown).events[0]?.button).toBe("wheel-down");
	});

	it("accepts a report whose leading ESC was already stripped", () => {
		// ink removes exactly one leading ESC before handing input to
		// useInput consumers, so the bare form is what InputBox sees.
		expect(parseMouseChunk("[<64;10;5M").events[0]?.button).toBe("wheel-up");
	});

	it("decodes modifier bits without losing the wheel direction", () => {
		expect(parseMouseChunk(`${ESC}[<68;1;1M`).events[0]).toMatchObject({
			button: "wheel-up",
			shift: true,
			alt: false,
			ctrl: false,
		});
		expect(parseMouseChunk(`${ESC}[<72;1;1M`).events[0]).toMatchObject({
			button: "wheel-up",
			alt: true,
		});
		expect(parseMouseChunk(`${ESC}[<80;1;1M`).events[0]).toMatchObject({
			button: "wheel-up",
			ctrl: true,
		});
		expect(parseMouseChunk(`${ESC}[<69;1;1M`).events[0]?.button).toBe("wheel-down");
	});

	it("marks a lowercase terminator as a release", () => {
		expect(parseMouseChunk(`${ESC}[<0;3;4m`).events[0]).toMatchObject({
			button: "other",
			release: true,
		});
	});

	it("classifies plain button presses as other", () => {
		expect(parseMouseChunk(`${ESC}[<0;3;4M`).events[0]?.button).toBe("other");
	});

	it("reads two reports out of a single chunk", () => {
		// Observed shape: ink strips only the FIRST ESC of the chunk, so the
		// leading report arrives bare and the trailing one keeps its ESC.
		const { events } = parseMouseChunk(`[<65;10;5M${ESC}[<65;11;5M`);
		expect(events.map((event) => event.column)).toEqual([10, 11]);
	});

	it("holds a report split across two reads until it completes", () => {
		const first = parseMouseChunk(`${ESC}[<64;10`);
		expect(first.events).toEqual([]);
		expect(first.rest).toBe(`${ESC}[<64;10`);

		const second = parseMouseChunk(`${first.rest};5M`);
		expect(second.events[0]).toMatchObject({ button: "wheel-up", column: 10, row: 5 });
		expect(second.rest).toBe("");
	});

	it("carries a partial report that begins mid-chunk", () => {
		expect(parseMouseChunk(`abc${ESC}[<64`).rest).toBe(`${ESC}[<64`);
	});

	it("keeps no pending bytes when the tail cannot start a report", () => {
		expect(parseMouseChunk("hello world").rest).toBe("");
		expect(parseMouseChunk(`${ESC}[<64;10;5Mtyping`).rest).toBe("");
	});

	it("refuses to buffer more than MAX_PENDING_BYTES", () => {
		// An unrelated "[<" must not wedge the buffer forever.
		const long = `${ESC}[<${"1".repeat(MAX_PENDING_BYTES + 20)}`;
		expect(parseMouseChunk(long).rest.length).toBeLessThanOrEqual(MAX_PENDING_BYTES);
	});

	it("ignores ordinary typing", () => {
		expect(parseMouseChunk("hello [not a mouse report]")).toEqual({ events: [], rest: "" });
	});
});

describe("stripMouseReports", () => {
	it("removes a report embedded in typed text", () => {
		expect(stripMouseReports(`a${ESC}[<64;10;5Mb`)).toBe("ab");
	});

	it("removes the bare form ink delivers to useInput", () => {
		expect(stripMouseReports("a[<64;10;5Mb")).toBe("ab");
	});

	it("returns an empty string for pure mouse noise", () => {
		expect(stripMouseReports("[<64;10;5M")).toBe("");
	});

	it("leaves ordinary typing untouched", () => {
		expect(stripMouseReports("hello")).toBe("hello");
		expect(stripMouseReports("a[<b")).toBe("a[<b");
	});

	it("does not eat an incomplete report — only ink's own chunking can split one", () => {
		expect(stripMouseReports("[<64;10")).toBe("[<64;10");
	});
});

describe("containsMouseReport", () => {
	it("detects both forms", () => {
		expect(containsMouseReport(wheelUp)).toBe(true);
		expect(containsMouseReport("[<64;10;5M")).toBe(true);
	});

	it("is false for ordinary typing", () => {
		expect(containsMouseReport("hello")).toBe(false);
	});
});

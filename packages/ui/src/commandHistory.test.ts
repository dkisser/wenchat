import { describe, expect, it } from "bun:test";
import { CommandHistory } from "./commandHistory";

describe("CommandHistory", () => {
	it("starts empty", () => {
		const h = new CommandHistory();
		expect(h.size).toBe(0);
		expect(h.prev("draft")).toBeNull();
		expect(h.next()).toBeNull();
	});

	it("push adds entries in order", () => {
		const h = new CommandHistory();
		h.push("first");
		h.push("second");
		h.push("third");
		expect(h.size).toBe(3);
	});

	it("ignores empty / whitespace-only entries", () => {
		const h = new CommandHistory();
		h.push("");
		h.push("   ");
		h.push("\t\n");
		expect(h.size).toBe(0);
	});

	it("collapses adjacent duplicates", () => {
		const h = new CommandHistory();
		h.push("same");
		h.push("same");
		h.push("same");
		h.push("other");
		h.push("other");
		expect(h.size).toBe(2);
	});

	it("prev recalls the most recent entry first", () => {
		const h = new CommandHistory();
		h.push("first");
		h.push("second");
		h.push("third");

		expect(h.prev("draft")).toBe("third");
		expect(h.prev("draft")).toBe("second");
		expect(h.prev("draft")).toBe("first");
	});

	it("prev returns null at the oldest entry (no further to go)", () => {
		const h = new CommandHistory();
		h.push("only");
		expect(h.prev("draft")).toBe("only");
		expect(h.prev("draft")).toBeNull();
	});

	it("next walks back toward the draft and stops at it", () => {
		const h = new CommandHistory();
		h.push("a");
		h.push("b");
		h.push("c");

		h.prev("DRAFT");
		h.prev("DRAFT");
		h.prev("DRAFT"); // now at oldest "a"

		expect(h.next()).toBe("b");
		expect(h.next()).toBe("c");
		expect(h.next()).toBe("DRAFT");
		expect(h.next()).toBeNull();
	});

	it("restores the original draft when stepping past the newest entry", () => {
		const h = new CommandHistory();
		h.push("cmd");
		h.prev("half-written draft");
		expect(h.next()).toBe("half-written draft");
	});

	it("push resets the navigation cursor (back to draft mode)", () => {
		const h = new CommandHistory();
		h.push("a");
		h.push("b");
		h.prev("X");
		h.prev("X");
		h.push("c");
		// After push, index is reset; prev should land on the newest entry again.
		expect(h.prev("Y")).toBe("c");
	});

	it("reset clears the navigation cursor", () => {
		const h = new CommandHistory();
		h.push("a");
		h.prev("X");
		h.reset();
		// After reset, the next prev should snapshot a fresh draft.
		expect(h.prev("FRESH")).toBe("a");
		expect(h.next()).toBe("FRESH");
	});

	it("up then down then up returns to the same entry", () => {
		const h = new CommandHistory();
		h.push("alpha");
		h.push("beta");
		h.prev("d");
		const afterUp = h.prev("d");
		h.next();
		const afterDownThenUp = h.prev("d");
		expect(afterUp).toBe("alpha");
		expect(afterDownThenUp).toBe("alpha");
	});

	it("empty history prev is a no-op (does not throw)", () => {
		const h = new CommandHistory();
		expect(() => h.prev("anything")).not.toThrow();
		expect(h.prev("anything")).toBeNull();
	});
});

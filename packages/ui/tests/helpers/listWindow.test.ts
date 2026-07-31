import { describe, expect, it } from "bun:test";
import { windowAround } from "../../src/listWindow";

describe("windowAround", () => {
	it("returns the whole list when it fits", () => {
		expect(windowAround(4, 10, 0)).toEqual({ start: 0, end: 4 });
	});

	it("centres the selection when there is room on both sides", () => {
		expect(windowAround(100, 5, 50)).toEqual({ start: 48, end: 53 });
	});

	it("sticks to the top while the selection is near the start", () => {
		expect(windowAround(100, 5, 0)).toEqual({ start: 0, end: 5 });
		expect(windowAround(100, 5, 1)).toEqual({ start: 0, end: 5 });
	});

	it("sticks to the bottom while the selection is near the end", () => {
		expect(windowAround(100, 5, 99)).toEqual({ start: 95, end: 100 });
	});

	it("always keeps the selection inside the window", () => {
		for (let selected = 0; selected < 50; selected++) {
			const { start, end } = windowAround(50, 7, selected);
			expect(selected).toBeGreaterThanOrEqual(start);
			expect(selected).toBeLessThan(end);
			expect(end - start).toBe(7);
		}
	});

	it("tolerates degenerate inputs", () => {
		expect(windowAround(0, 5, 0)).toEqual({ start: 0, end: 0 });
		expect(windowAround(5, 0, 2)).toEqual({ start: 0, end: 0 });
		expect(windowAround(5, 3, -1)).toEqual({ start: 0, end: 3 });
		expect(windowAround(5, 3, 99)).toEqual({ start: 2, end: 5 });
	});
});

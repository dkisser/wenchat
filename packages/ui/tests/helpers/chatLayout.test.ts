import { describe, expect, it } from "bun:test";
import { CHROME_ROWS, MIN_FRAME_HEIGHT, computeChatLayout } from "../../src/chatLayout";

describe("computeChatLayout", () => {
	it("reserves one row below the frame so ink never repaints the whole terminal", () => {
		// ink's onRender writes `clearTerminal` (which also wipes scrollback)
		// whenever outputHeight >= stdout.rows, and log-update appends a
		// trailing newline. Targeting rows - 1 keeps us one row under that.
		const layout = computeChatLayout({ rows: 24, columns: 80, suggestionVisible: false });
		expect(layout.frameHeight).toBe(23);
	});

	it("computes the standard 80x24 layout without a suggestion row", () => {
		const layout = computeChatLayout({ rows: 24, columns: 80, suggestionVisible: false });
		expect(layout).toEqual({
			frameHeight: 23,
			chatOuterHeight: 18,
			viewportHeight: 17,
			contentWidth: 78,
			degraded: false,
		});
	});

	it("gives the suggestion row its own three rows of chrome", () => {
		const without = computeChatLayout({ rows: 24, columns: 80, suggestionVisible: false });
		const withRow = computeChatLayout({ rows: 24, columns: 80, suggestionVisible: true });
		expect(without.chatOuterHeight - withRow.chatOuterHeight).toBe(CHROME_ROWS.commandSuggestion);
		expect(withRow.frameHeight).toBe(without.frameHeight);
	});

	it("trades three viewport rows for the logo header when it replaces the StatusBar", () => {
		const bar = computeChatLayout({ rows: 24, columns: 80, suggestionVisible: false });
		const logo = computeChatLayout({
			rows: 24,
			columns: 80,
			suggestionVisible: false,
			logoHeader: true,
		});
		expect(bar.chatOuterHeight - logo.chatOuterHeight).toBe(
			CHROME_ROWS.header - CHROME_ROWS.statusBar,
		);
		expect(logo.frameHeight).toBe(bar.frameHeight);
	});

	it("reserves exactly one gutter row between the top chrome and the chat viewport", () => {
		const layout = computeChatLayout({ rows: 40, columns: 120, suggestionVisible: false });
		expect(layout.chatOuterHeight - layout.viewportHeight).toBe(CHROME_ROWS.chatGutter);
	});

	it("subtracts left + right padding from the columns to get the content width", () => {
		// The chat pane is borderless now: getMaxWidth = width - paddingLeft - paddingRight
		expect(
			computeChatLayout({ rows: 24, columns: 20, suggestionVisible: false }).contentWidth,
		).toBe(18);
	});

	it("floors the frame height so a tiny terminal never produces negative sizes", () => {
		const layout = computeChatLayout({ rows: 1, columns: 3, suggestionVisible: false });
		expect(layout.frameHeight).toBe(MIN_FRAME_HEIGHT);
		expect(layout.chatOuterHeight).toBeGreaterThanOrEqual(3);
		expect(layout.viewportHeight).toBeGreaterThanOrEqual(1);
		expect(layout.contentWidth).toBeGreaterThanOrEqual(1);
	});

	it("flags a terminal too short to hold the full chrome as degraded", () => {
		// topMargin (1) + StatusBar (1) + InputBox (3) = 5 rows of fixed
		// chrome. With a 6-row frame (`rows - 1`), only 1 row is left for the
		// chat pane — below the 3-row floor, so degraded.
		expect(computeChatLayout({ rows: 7, columns: 80, suggestionVisible: false }).degraded).toBe(
			true,
		);
		expect(computeChatLayout({ rows: 24, columns: 80, suggestionVisible: false }).degraded).toBe(
			false,
		);
	});

	it("never returns a non-positive dimension across a sweep of terminal sizes", () => {
		for (let rows = 1; rows <= 60; rows++) {
			for (const columns of [1, 2, 5, 40, 200]) {
				for (const suggestionVisible of [false, true]) {
					const layout = computeChatLayout({ rows, columns, suggestionVisible });
					expect(layout.frameHeight).toBeGreaterThan(0);
					expect(layout.chatOuterHeight).toBeGreaterThan(0);
					expect(layout.viewportHeight).toBeGreaterThan(0);
					expect(layout.contentWidth).toBeGreaterThan(0);
				}
			}
		}
	});
});

import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import { FILE_SUGGESTION_MAX_ROWS, FileSuggestion } from "../../src/FileSuggestion";
import type { FileCandidate } from "../../src/fileCompletion";

const file = (name: string): FileCandidate => ({ name, isDirectory: false });
const dir = (name: string): FileCandidate => ({ name, isDirectory: true });

describe("FileSuggestion", () => {
	it("renders nothing for an empty candidate list", () => {
		const { lastFrame } = render(<FileSuggestion candidates={[]} selectedIndex={0} />);
		expect(lastFrame()).toBe("");
	});

	it("shows a trailing slash on directories only", () => {
		const { lastFrame } = render(
			<FileSuggestion candidates={[dir("docs"), file("notes.txt")]} selectedIndex={0} />,
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("docs/");
		expect(frame).toContain("notes.txt");
		expect(frame).not.toContain("notes.txt/");
	});

	it("marks the selected row with inverse video, no > marker", () => {
		const { lastFrame } = render(
			<FileSuggestion candidates={[file("a.txt"), file("b.txt")]} selectedIndex={1} />,
		);
		const frame = lastFrame() ?? "";
		expect(frame).not.toContain(">");
		// ansi-styles inverse: \x1b[7m … \x1b[27m around the selected name.
		const inverseStart = frame.indexOf("\u001b[7m");
		expect(inverseStart).toBeGreaterThanOrEqual(0);
		expect(frame.indexOf("b.txt")).toBeGreaterThan(inverseStart);
	});

	it("caps the visible window at the max row count", () => {
		const candidates = Array.from({ length: 10 }, (_, i) => file(`f${i}.txt`));
		const { lastFrame } = render(<FileSuggestion candidates={candidates} selectedIndex={0} />);
		const rows = (lastFrame() ?? "").split("\n");
		// 4 candidate rows + 2 border rows.
		expect(rows.length).toBe(FILE_SUGGESTION_MAX_ROWS + 2);
		expect(lastFrame()).toContain("f0.txt");
		expect(lastFrame()).not.toContain("f9.txt");
	});

	it("windows around a selection near the end of a long list", () => {
		const candidates = Array.from({ length: 10 }, (_, i) => file(`f${i}.txt`));
		const { lastFrame } = render(<FileSuggestion candidates={candidates} selectedIndex={9} />);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("f9.txt");
		expect(frame).not.toContain("f0.txt");
		const rows = frame.split("\n");
		expect(rows.length).toBe(FILE_SUGGESTION_MAX_ROWS + 2);
	});
});

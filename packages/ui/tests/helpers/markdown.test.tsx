import { describe, expect, it } from "bun:test";
import { renderMarkdown } from "../../src/markdown";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const INVERSE = "\x1b[7m";
const BG_GRAY = "\x1b[48;5;236m";

describe("renderMarkdown", () => {
	it("returns empty string for empty input", () => {
		expect(renderMarkdown("")).toBe("");
	});

	it("renders plain text verbatim", () => {
		expect(renderMarkdown("hello world")).toBe("hello world");
	});

	it("wraps bold text with SGR bold codes", () => {
		const out = renderMarkdown("**bold**");
		expect(out).toBe(`${BOLD}bold${RESET}`);
	});

	it("wraps italic text with SGR italic codes", () => {
		const out = renderMarkdown("*italic*");
		expect(out).toBe(`${ITALIC}italic${RESET}`);
	});

	it("wraps inline code with inverse + cyan", () => {
		const out = renderMarkdown("`code`");
		expect(out).toBe(`${INVERSE}${CYAN}code${RESET}`);
	});

	it("renders headings as bold without # markers", () => {
		const out = renderMarkdown("# Heading\n\nbody");
		// heading takes the first block; body is the second block.
		// They are joined with \n.
		expect(out).toContain(`${BOLD}Heading${RESET}`);
		expect(out).not.toContain("# Heading");
	});

	it("renders a fenced code block with language label and background", () => {
		const source = "```ts\nconst x = 1;\n```";
		const out = renderMarkdown(source);
		// Language label line is bold "ts"
		expect(out).toContain(`${BOLD}ts${RESET}`);
		// Each code line is wrapped with bg-gray
		const lines = out.split("\n");
		const codeLines = lines.filter((l) => l.includes("const"));
		expect(codeLines.length).toBeGreaterThan(0);
		for (const line of codeLines) {
			expect(line).toStartWith(BG_GRAY);
			expect(line).toEndWith(RESET);
		}
		// cli-highlight emits ANSI (chalk uses 24-bit hex sequences)
		// So we expect at least one ANSI escape inside the bg-gray wrapper.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC byte used by ANSI escape sequences
		expect(out).toMatch(/\x1b\[/);
	});

	it("renders a fenced code block with no language using a generic label", () => {
		const out = renderMarkdown("```\nplain\n```");
		expect(out).toContain(`${BOLD}code${RESET}`);
		expect(out).toContain("plain");
	});

	it("renders blockquotes with a leading bar", () => {
		const out = renderMarkdown("> quoted text");
		expect(out).toContain(`${DIM}▎${RESET}`);
		expect(out).toContain("quoted text");
	});

	it("renders unordered lists with bullets", () => {
		const out = renderMarkdown("- one\n- two");
		expect(out).toContain(`${BOLD}•${RESET} one`);
		expect(out).toContain(`${BOLD}•${RESET} two`);
	});

	it("renders ordered lists with numbers", () => {
		const out = renderMarkdown("1. first\n2. second");
		expect(out).toContain(`${BOLD}1.${RESET} first`);
		expect(out).toContain(`${BOLD}2.${RESET} second`);
	});

	it("renders hr as a line of dashes", () => {
		const out = renderMarkdown("---");
		expect(out).toMatch(/─/);
	});

	it("renders links as cyan underlined text", () => {
		const out = renderMarkdown("[click](https://example.com)");
		expect(out).toContain(`${UNDERLINE}${CYAN}click${RESET}`);
		expect(out).not.toContain("https://example.com");
	});

	it("preserves multiple spaces inside paragraphs", () => {
		// marked preserves inline whitespace in `tokens.text`; the renderer
		// must not collapse it.
		const out = renderMarkdown("a    b");
		expect(out).toContain("a    b");
	});

	it("preserves explicit newlines as hard breaks", () => {
		// Two trailing spaces + newline is a hard break in CommonMark.
		const out = renderMarkdown("line one  \nline two");
		expect(out).toContain("\n");
	});

	it("joins consecutive paragraphs with a blank line between them", () => {
		// marked emits a `space` token between the two paragraph tokens;
		// joining with "\n" produces a visible blank row, which is exactly
		// what we want for vertical separation.
		const out = renderMarkdown("first\n\nsecond");
		expect(out).toBe("first\n\nsecond");
	});

	it("emits a blank line for a blank-line-separated block", () => {
		const out = renderMarkdown("first\n\n\nsecond");
		// 3 consecutive \n → two empty strings between "first" and "second".
		expect(out.split("\n").length).toBeGreaterThanOrEqual(3);
		expect(out.startsWith("first")).toBe(true);
		expect(out.endsWith("second")).toBe(true);
	});
});

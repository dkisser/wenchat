import { highlight } from "cli-highlight";
import { type Tokens, marked } from "marked";

/**
 * Pure markdown → ANSI escape-coded string for terminal rendering.
 *
 * Why a string and not a React tree: ChatView receives flat display lines
 * and `<Text wrap="wrap">` already handles soft wrapping via the same
 * `wrap-ansi` options `wrapToWidth` uses (`{trim:false, hard:true}`). Ink's
 * output pipeline parses ANSI via `@alcalzone/ansi-tokenize`, so SGR bytes
 * embedded here render as real styles without any extra wiring.
 *
 * Block boundaries are emitted as literal `\n` so the surrounding wrap
 * pass sees the original newline count — code fences and preformatted text
 * render on multiple distinct lines.
 */
export function renderMarkdown(source: string): string {
	if (source.length === 0) return "";
	marked.use({ gfm: false, async: false });
	const tokens = marked.lexer(source);
	return tokens.map(renderBlock).join("\n");
}

// --- SGR bytes ---------------------------------------------------------
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const INVERSE = "\x1b[7m";
const BG_GRAY = "\x1b[48;5;236m";

// --- Block tokens ------------------------------------------------------

function renderBlock(token: Tokens.Generic): string {
	const t = token as Tokens.Generic & { type?: string; text?: string; raw?: string };
	switch (t.type) {
		case "heading":
			return renderHeading(token as Tokens.Heading);
		case "paragraph":
			return renderParagraph(token as Tokens.Paragraph);
		case "code":
			return renderCode(token as Tokens.Code);
		case "blockquote":
			return renderBlockquote(token as Tokens.Blockquote);
		case "list":
			return renderList(token as Tokens.List);
		case "hr":
			return "─".repeat(78);
		case "space":
			return "";
		default:
			// Defensive fallback for block types we don't style specially
			// (def, table, html, etc.) — keep whatever inline text they hold
			// visible rather than dropping it.
			return t.text ?? t.raw ?? "";
	}
}

function renderHeading(token: Tokens.Heading): string {
	// h1–h6 all render as bold. Heading depth is rare in chat; varying it
	// would force the reader to remember the visual weight mapping.
	return `${BOLD}${renderInlines(token.tokens ?? [])}${RESET}`;
}

function renderParagraph(token: Tokens.Paragraph): string {
	return renderInlines(token.tokens ?? []);
}

function renderCode(token: Tokens.Code): string {
	const language = token.lang?.trim() || "code";
	let body: string;
	try {
		body = highlight(token.text, { language: token.lang?.trim() || undefined });
	} catch {
		// cli-highlight throws on unknown language — fall back to the raw text.
		body = token.text;
	}
	const codeLines = body.split("\n");
	const wrapped = codeLines.map((line) => `${BG_GRAY}${line}${RESET}`);
	return [`${BOLD}${language}${RESET}`, ...wrapped].join("\n");
}

function renderBlockquote(token: Tokens.Blockquote): string {
	// CommonMark allows blockquotes to nest other block tokens. Render each
	// inner token on its own line and prefix every output line with the bar.
	const inner = token.tokens ?? [];
	const rendered = inner.map(renderBlock).join("\n");
	return rendered
		.split("\n")
		.map((line) => `${DIM}▎${RESET} ${line}`)
		.join("\n");
}

function renderList(token: Tokens.List): string {
	const ordered = token.ordered;
	const start = ordered ? Number(token.start ?? 1) : null;
	const items = token.items ?? [];
	return items
		.map((item, idx) => {
			const number = start !== null ? start + idx : idx + 1;
			const prefix = ordered ? `${BOLD}${number}.${RESET} ` : `${BOLD}•${RESET} `;
			// A list item's `tokens` is itself a list of block tokens; flatten
			// to a single string so the bullet prefixes the first line and
			// continuation lines indent under it.
			const body = (item.tokens ?? [])
				.map((child) => renderBlock(child as Tokens.Generic))
				.join("\n");
			const lines = body.split("\n");
			return [prefix + (lines[0] ?? ""), ...lines.slice(1).map((l) => `  ${l}`)].join("\n");
		})
		.join("\n");
}

// --- Inline tokens -----------------------------------------------------

function renderInlines(tokens: readonly Tokens.Generic[]): string {
	let out = "";
	for (const child of tokens) {
		out += renderInline(child as Tokens.Generic);
	}
	return out;
}

function renderInline(token: Tokens.Generic): string {
	const t = token as Tokens.Generic & { type?: string };
	switch (t.type) {
		case "text":
			return (token as Tokens.Text).text;
		case "escape":
			return (token as Tokens.Escape).text;
		case "codespan":
			return `${INVERSE}${CYAN}${(token as Tokens.Codespan).text}${RESET}`;
		case "strong":
			return `${BOLD}${renderInlines((token as Tokens.Strong).tokens ?? [])}${RESET}`;
		case "em":
			return `${ITALIC}${renderInlines((token as Tokens.Em).tokens ?? [])}${RESET}`;
		case "del": {
			const inner = renderInlines((token as Tokens.Del).tokens ?? []);
			// Dim + strike-through (SGR 9). Terminals vary on 9 support;
			// the dim fall-back still reads as "deleted".
			return `${DIM}\x1b[9m${inner}${RESET}`;
		}
		case "link": {
			// Suppress the URL — a TUI chat can't follow hyperlinks, and
			// emitting the URL after the text would consume wrap width.
			return `${UNDERLINE}${CYAN}${renderInlines((token as Tokens.Link).tokens ?? [])}${RESET}`;
		}
		case "br":
			return "\n";
		case "image":
			return (token as Tokens.Image).text;
		default: {
			// Unknown inline type: best-effort textual fallback.
			const fallback = t as Tokens.Generic & { text?: string };
			return fallback.text ?? "";
		}
	}
}

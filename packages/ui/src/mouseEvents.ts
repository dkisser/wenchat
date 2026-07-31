/**
 * Pure parser for xterm SGR mouse reports (`CSI < btn ; col ; row M|m`).
 *
 * Two shapes have to be recognised. The raw stdin chunk keeps its ESC, but
 * ink strips exactly one leading ESC per chunk before handing input to
 * `useInput` consumers — so a chunk carrying two reports arrives as
 * `"[<65;10;5M[<65;11;5M"`, with the first one bare.
 *
 * Only the SGR encoding (enabled with `?1006h`) is handled. The legacy X10
 * encoding is deliberately unsupported: its payload is three raw bytes with no
 * delimiter, so `[Mabc` typed by a user is indistinguishable from a real
 * report, and stripping it would eat legitimate input. Every terminal we
 * enable tracking on has honoured `?1006h` for well over a decade.
 */

export type MouseButton = "wheel-up" | "wheel-down" | "other";

export type MouseEvent = {
	readonly button: MouseButton;
	readonly buttonCode: number;
	readonly column: number;
	readonly row: number;
	readonly release: boolean;
	readonly shift: boolean;
	readonly alt: boolean;
	readonly ctrl: boolean;
};

export type MouseParseResult = {
	readonly events: readonly MouseEvent[];
	/** Trailing partial report to prepend to the next chunk. */
	readonly rest: string;
};

/** Upper bound on carried-over bytes, so a stray "[<" can never wedge us. */
export const MAX_PENDING_BYTES = 64;

const ESC = "\u001B";
const WHEEL_FLAG = 0b0100_0000;
const SHIFT_FLAG = 0b0000_0100;
const ALT_FLAG = 0b0000_1000;
const CTRL_FLAG = 0b0001_0000;
const BUTTON_MASK = 0b0000_0011;
const MAX_FIELD_DIGITS = 5;

// The leading ESC is optional — see the module comment.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the source-escape form  is intentional — it matches the ESC byte in incoming ANSI mouse reports, the same construct every other xterm parser uses.
const REPORT_PATTERN = /\u001B?\[<(\d{1,5});(\d{1,5});(\d{1,5})([Mm])/g;

/**
 * Extract every complete mouse report from `buffered`, returning any trailing
 * partial report so the caller can prepend it to the next stdin chunk.
 *
 * Non-report text is simply ignored: this parser is only ever a *listener* on
 * the input stream, never its consumer.
 */
export function parseMouseChunk(buffered: string): MouseParseResult {
	const events: MouseEvent[] = [];
	let consumedTo = 0;

	REPORT_PATTERN.lastIndex = 0;
	let match = REPORT_PATTERN.exec(buffered);
	while (match !== null) {
		events.push(toMouseEvent(match));
		consumedTo = REPORT_PATTERN.lastIndex;
		match = REPORT_PATTERN.exec(buffered);
	}

	return { events, rest: trailingReportPrefix(buffered.slice(consumedTo)) };
}

/**
 * Remove every complete mouse report from a string, leaving the rest intact.
 *
 * Incomplete reports are left alone on purpose: only ink's own chunking can
 * split one, and eating a bare `[<` would corrupt genuinely typed text.
 */
export function stripMouseReports(input: string): string {
	return input.replace(REPORT_PATTERN, "");
}

export function containsMouseReport(input: string): boolean {
	REPORT_PATTERN.lastIndex = 0;
	return REPORT_PATTERN.test(input);
}

function toMouseEvent(match: RegExpExecArray): MouseEvent {
	const buttonCode = Number(match[1]);
	const isWheel = (buttonCode & WHEEL_FLAG) !== 0;
	const low = buttonCode & BUTTON_MASK;

	let button: MouseButton = "other";
	if (isWheel && low === 0) button = "wheel-up";
	else if (isWheel && low === 1) button = "wheel-down";

	return {
		button,
		buttonCode,
		column: Number(match[2]),
		row: Number(match[3]),
		release: match[4] === "m",
		shift: (buttonCode & SHIFT_FLAG) !== 0,
		alt: (buttonCode & ALT_FLAG) !== 0,
		ctrl: (buttonCode & CTRL_FLAG) !== 0,
	};
}

/**
 * Longest suffix of `tail` that could still grow into a valid report.
 */
function trailingReportPrefix(tail: string): string {
	const earliest = Math.max(0, tail.length - MAX_PENDING_BYTES);
	for (let start = earliest; start < tail.length; start++) {
		const candidate = tail[start];
		if (candidate !== ESC && candidate !== "[") continue;
		const suffix = tail.slice(start);
		if (isReportPrefix(suffix)) return suffix;
	}
	return "";
}

/** True when `text` is a strict prefix of some complete report. */
function isReportPrefix(text: string): boolean {
	let index = 0;
	if (text[index] === ESC) index++;
	if (index === text.length) return true;
	if (text[index] !== "[") return false;
	index++;
	if (index === text.length) return true;
	if (text[index] !== "<") return false;
	index++;

	let fieldsSeen = 0;
	let digitsInField = 0;
	while (index < text.length) {
		const char = text[index];
		if (char !== undefined && char >= "0" && char <= "9") {
			digitsInField++;
			if (digitsInField > MAX_FIELD_DIGITS) return false;
			index++;
			continue;
		}
		if (char === ";") {
			if (digitsInField === 0 || fieldsSeen >= 2) return false;
			fieldsSeen++;
			digitsInField = 0;
			index++;
			continue;
		}
		// A terminator would have produced a complete match already, so
		// anything else means this is not a report after all.
		return false;
	}
	return true;
}

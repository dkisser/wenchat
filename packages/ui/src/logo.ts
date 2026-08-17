/**
 * The WENCHAT wordmark, rendered with figlet's `smslant` font and frozen
 * here as a constant — the CLI has no figlet dependency at runtime.
 * Trailing whitespace is trimmed per line; every line is exactly
 * {@link LOGO_WIDTH} columns or less.
 */
export const LOGO_LINES: readonly string[] = [
	" _      _______  _________ _____ ______",
	"| | /| / / __/ |/ / ___/ // / _ /_  __/",
	"| |/ |/ / _//    / /__/ _  / __ |/ /",
	"|__/|__/___/_/|_/\\___/_//_/_/ |_/_/",
];

/** Width of the widest logo line, in terminal columns. */
export const LOGO_WIDTH = 38;

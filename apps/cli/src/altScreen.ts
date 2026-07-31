import process from "node:process";

// VT100 / xterm alternate screen buffer control sequences.
// \x1b[?1049h — switch to alternate screen
// \x1b[?1049l — switch back to primary screen
// \x1b[?25l  /  \x1b[?25h — hide / show the host cursor
// \x1b[H    — move cursor to home position (row 1, col 1)
const ENTER_ALT = "\x1b[?1049h\x1b[H";
const EXIT_ALT = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

let entered = false;

/**
 * Enter the alternate screen buffer if stdout is a TTY.
 *
 * Idempotent: a second call is a no-op until `exitAltScreen()` runs. Non-TTY
 * streams (piped output, CI logs) are skipped so `bun run cli > out.log`
 * keeps producing plain text without escape sequences.
 *
 * @returns true if we actually entered the alternate buffer; false if we
 *   skipped (non-TTY or already inside).
 */
export function enterAltScreen(): boolean {
	if (entered || !process.stdout.isTTY) return false;
	process.stdout.write(ENTER_ALT);
	process.stdout.write(HIDE_CURSOR);
	entered = true;
	return true;
}

/**
 * Exit the alternate screen buffer if we entered it.
 *
 * Idempotent: safe to call multiple times and safe to call even if
 * `enterAltScreen()` never ran (e.g. non-TTY, or startup crashed before
 * render). Restores the host cursor before the exit sequence so the user's
 * shell prompt has a visible caret immediately.
 */
export function exitAltScreen(): void {
	if (!entered) return;
	process.stdout.write(SHOW_CURSOR);
	process.stdout.write(EXIT_ALT);
	entered = false;
}

/**
 * Test-only: reset internal state without writing any escape sequences.
 * Production code should always pair `enterAltScreen()` with
 * `exitAltScreen()`; this exists so unit tests can run between assertions
 * without leaking state across cases.
 */
export function __resetAltScreenForTests(): void {
	entered = false;
}

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

/**
 * Install process-level hooks that guarantee the alternate screen buffer is
 * released on every exit path, including ones that bypass the React tree:
 *
 * - SIGINT (Ctrl+C) — write exit sequence, then terminate with 130 (128+SIGINT).
 * - SIGTERM         — write exit sequence, then terminate with 143.
 * - `beforeExit`    — Node fires this when the event loop drains; if Ink's
 *                     unmount finishes cleanly we still want to release the
 *                     buffer. `waitUntilExit()` in main.tsx will normally run
 *                     first, so this is a backstop.
 * - `uncaughtException` / `unhandledRejection` — log to stderr, release the
 *                     buffer, then exit non-zero so the user sees a clear
 *                     failure rather than a hung terminal.
 *
 * Returns an `uninstall` thunk that removes every handler. Tests use it to
 * keep handlers from leaking across cases.
 */
export function installAltScreenSafetyNet(): () => void {
	const onSigint = () => {
		exitAltScreen();
		// Echo a newline so the shell prompt doesn't land on the same line
		// as the last TUI frame, and use 130 (the conventional exit code for
		// "killed by SIGINT") so shell scripts can detect Ctrl+C.
		process.stdout.write("\n");
		process.exit(130);
	};
	const onSigterm = () => {
		exitAltScreen();
		process.exit(143);
	};
	const onBeforeExit = () => {
		exitAltScreen();
	};
	const onUncaught = (err: unknown) => {
		const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
		process.stderr.write(`\n[cli] uncaught: ${detail}\n`);
		exitAltScreen();
		process.exit(1);
	};
	const onUnhandledRejection = (reason: unknown) => {
		process.stderr.write(`\n[cli] unhandled rejection: ${String(reason)}\n`);
		exitAltScreen();
		process.exit(1);
	};

	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);
	process.on("beforeExit", onBeforeExit);
	process.on("uncaughtException", onUncaught);
	process.on("unhandledRejection", onUnhandledRejection);

	return () => {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
		process.off("beforeExit", onBeforeExit);
		process.off("uncaughtException", onUncaught);
		process.off("unhandledRejection", onUnhandledRejection);
	};
}

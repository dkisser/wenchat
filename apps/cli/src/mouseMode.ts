import process from "node:process";

// xterm mouse-tracking control sequences.
// \x1b[?1000h / l — X11 "normal tracking": report button press/release.
//                   Wheel ticks are encoded as buttons 4/5 and arrive as
//                   press events, so normal tracking is all we need. ?1002
//                   (drag) and ?1003 (any motion) add a firehose of motion
//                   events with zero benefit for scrolling — and every extra
//                   byte is another chance for one to leak into the InputBox.
// \x1b[?1006h / l — SGR extended coordinates: text-delimited, unambiguous,
//                   and free of the legacy encoding's 223-column ceiling.
const ENABLE_MOUSE = "[?1000h[?1006h";
const DISABLE_MOUSE = "[?1006l[?1000l";

let entered = false;

/**
 * Turn on mouse reporting so the app receives wheel events.
 *
 * Requires stdout to be a TTY (to write the sequence at all) *and* stdin to be
 * a TTY (nothing would deliver the reports otherwise). Idempotent until
 * {@link exitMouseMode} runs.
 *
 * Side effect worth knowing: while tracking is on, the terminal stops handling
 * drag-to-select natively — users hold Shift (xterm/iTerm2) or Option (macOS
 * Terminal) to select text. Tracking also supersedes alternate-scroll mode
 * (`?1007`), which would otherwise translate wheel ticks into bare arrow keys
 * and trip the InputBox's history recall.
 *
 * @returns true if tracking was enabled; false if skipped.
 */
export function enterMouseMode(): boolean {
	if (entered || !process.stdout.isTTY || !process.stdin.isTTY) return false;
	process.stdout.write(ENABLE_MOUSE);
	entered = true;
	return true;
}

/**
 * Turn mouse reporting back off. Idempotent, and safe to call even if
 * {@link enterMouseMode} never ran.
 *
 * This must happen on *every* exit path. A leaked `?1006h` leaves the user's
 * shell printing `[<64;…M` on every wheel tick.
 */
export function exitMouseMode(): void {
	if (!entered) return;
	process.stdout.write(DISABLE_MOUSE);
	entered = false;
}

/**
 * Test-only: reset internal state without writing any escape sequences.
 */
export function __resetMouseModeForTests(): void {
	entered = false;
}

import process from "node:process";
import { getLogger } from "@wenchat/core";

export type TerminalReleaseFn = () => void;

/**
 * Install process-level hooks that guarantee every terminal mode we turned on
 * is released on every exit path, including ones that bypass the React tree:
 *
 * - SIGINT (Ctrl+C) — release, then terminate with 130 (128+SIGINT).
 * - SIGTERM         — release, then terminate with 143.
 * - `beforeExit`    — Node fires this when the event loop drains; if Ink's
 *                     unmount finishes cleanly we still want to release.
 *                     `waitUntilExit()` in main.tsx will normally run first,
 *                     so this is a backstop.
 * - `uncaughtException` / `unhandledRejection` — log to stderr, release, then
 *                     exit non-zero so the user sees a clear failure rather
 *                     than a hung terminal.
 *
 * `releases` runs in array order before the process exits, so pass the modes
 * innermost-first (mouse tracking before the alternate screen).
 *
 * Why one net with an ordered list rather than one net per mode: the SIGINT
 * handler calls `process.exit(130)`. Node runs listeners in registration
 * order, so the first handler to fire terminates the process and any sibling
 * handler never executes — a second, parallel net would leak its escape
 * sequence roughly half the time depending on registration order.
 *
 * Returns an `uninstall` thunk that removes every handler. Tests use it to
 * keep handlers from leaking across cases.
 */
export function installTerminalSafetyNet(releases: readonly TerminalReleaseFn[]): () => void {
	const releaseAll = () => {
		for (const release of releases) release();
	};

	const onSigint = () => {
		releaseAll();
		// Echo a newline so the shell prompt doesn't land on the same line
		// as the last TUI frame, and use 130 (the conventional exit code for
		// "killed by SIGINT") so shell scripts can detect Ctrl+C.
		process.stdout.write("\n");
		process.exit(130);
	};
	const onSigterm = () => {
		releaseAll();
		process.exit(143);
	};
	const onBeforeExit = () => {
		releaseAll();
	};
	const onUncaught = (err: unknown) => {
		const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
		// Best-effort: the crash detail also lands in the daily log file, so a
		// TUI session that dies leaves a durable trace (stderr is transient).
		getLogger().fatal({ err }, "uncaught exception");
		getLogger().flush();
		process.stderr.write(`\n[cli] uncaught: ${detail}\n`);
		releaseAll();
		process.exit(1);
	};
	const onUnhandledRejection = (reason: unknown) => {
		getLogger().fatal({ err: reason }, "unhandled rejection");
		getLogger().flush();
		process.stderr.write(`\n[cli] unhandled rejection: ${String(reason)}\n`);
		releaseAll();
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

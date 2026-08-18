import { readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import pino from "pino";

export type Logger = pino.Logger;

/**
 * Logs live in a `logs/` directory under the workspace root, one file per
 * local day: `wenchat-YYYY-MM-DD.log`.
 *
 * Date-stamped names make retention a pure filename decision — no state file,
 * no rotation metadata, correct even after a crash. Pruning runs at startup
 * and once at each local midnight (which is also when the destination swaps
 * to the new day's file).
 */
const LOG_FILE_PATTERN = /^wenchat-(\d{4})-(\d{2})-(\d{2})\.log$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 7;

type VersionHolder = { __WENCHAT_VERSION__?: string };

/**
 * Root for wenchat's on-disk state, split by how the process was started:
 *
 * - **Packed release binary** (esbuild injected `__WENCHAT_VERSION__`):
 *   `~/.wenchat` — alongside the persisted mDNS local-id, so logs end up at
 *   `~/.wenchat/logs`.
 * - **Anything else** (`bun run cli` from a source checkout, tests): the
 *   current working directory — the repo root in practice — so development
 *   logs stay in `./logs` and never mix with the deployed location.
 */
export function getWorkspaceRoot(): string {
	if (typeof (globalThis as VersionHolder).__WENCHAT_VERSION__ === "string") {
		return join(homedir(), ".wenchat");
	}
	return process.cwd();
}

export function getLogDir(root: string = getWorkspaceRoot()): string {
	return join(root, "logs");
}

function formatLogDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/** Today's log file — the path error messages point users at. */
export function getLogFilePath(date: Date = new Date(), root: string = getWorkspaceRoot()): string {
	return join(getLogDir(root), `wenchat-${formatLogDate(date)}.log`);
}

/**
 * Delete date-stamped log files older than `retentionDays` (today counts as
 * day one, so 7 keeps today plus the previous six days). Filename dates are
 * compared instead of mtimes so a `touch` can't resurrect an expired file.
 * Best-effort: a missing directory or a single undeletable file is skipped.
 */
export async function pruneOldLogs(opts?: {
	logDir?: string;
	retentionDays?: number;
	now?: Date;
}): Promise<void> {
	const logDir = opts?.logDir ?? getLogDir();
	const retentionDays = opts?.retentionDays ?? DEFAULT_RETENTION_DAYS;
	const now = opts?.now ?? new Date();
	const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const cutoff = todayStart - (retentionDays - 1) * DAY_MS;

	let entries: string[];
	try {
		entries = await readdir(logDir);
	} catch {
		return; // directory doesn't exist yet — nothing to prune
	}
	for (const entry of entries) {
		const match = LOG_FILE_PATTERN.exec(entry);
		if (!match) continue;
		const fileDay = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
		if (fileDay >= cutoff) continue;
		try {
			await unlink(join(logDir, entry));
		} catch {
			// best-effort: leave the file, prune will retry next launch
		}
	}
}

// Disabled by default so library consumers and tests that never call
// initLogger() neither create files nor write anywhere (pino's default
// destination is stdout — which would corrupt the Ink alt-screen).
let current: Logger = pino({ enabled: false });
let midnightTimer: NodeJS.Timeout | undefined;

// The sonic-boom destination behind `current`, when it is a file logger.
// Tracked separately because a pino Logger doesn't expose its stream, and
// the stream is what must be flushSync'd on exit and end()ed on rollover
// (otherwise each midnight leaks one fd and the tail of the log is lost
// on a normal process exit).
type FileDestination = ReturnType<typeof pino.destination>;
let currentDestination: FileDestination | undefined;
let exitHookInstalled = false;

export type InitLoggerOptions = {
	level?: string;
	/** Override the log directory (tests). Defaults to `<workspaceRoot>/logs`. */
	logDir?: string;
	/** Clock injection for tests; production callers leave it unset. */
	now?: Date;
};

/**
 * Create the process-wide file logger: prune expired logs, open today's
 * file, and arm an unref'd timer that prunes + swaps the destination at the
 * next local midnight. Callers must use `getLogger()` per call site (never
 * cache the reference) so the midnight swap is picked up.
 */
export async function initLogger(opts?: InitLoggerOptions): Promise<Logger> {
	const logDir = opts?.logDir ?? getLogDir();
	const level = opts?.level ?? process.env.WENCHAT_LOG_LEVEL ?? "info";
	const now = opts?.now ?? new Date();
	await pruneOldLogs({ logDir, now });
	const next = createFileLogger(logDir, level, now);
	current = next.logger;
	currentDestination = next.destination;
	installExitFlush();
	armMidnightRollover(logDir, level, now);
	return current;
}

function createFileLogger(
	logDir: string,
	level: string,
	now: Date,
): { logger: Logger; destination: FileDestination } {
	const destination = pino.destination({
		dest: join(logDir, `wenchat-${formatLogDate(now)}.log`),
		mkdir: true,
		sync: false,
	});
	return { logger: pino({ level }, destination), destination };
}

/**
 * pino's async destination buffers writes; on a normal `process.exit` the
 * buffer would die with the process, silently dropping the tail of the log
 * (often the crash-relevant lines). The "exit" event only permits sync
 * work, and sonic-boom's flushSync is exactly that. Installed once — the
 * hook reads the CURRENT destination at exit time, so it stays correct
 * across midnight rollovers.
 */
function installExitFlush(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.on("exit", () => {
		try {
			currentDestination?.flushSync();
		} catch {
			// The destination may already be broken; nothing more to do at exit.
		}
	});
}

/** Flush pending writes, then release the fd. Best-effort, never throws. */
function closeDestination(destination: FileDestination | undefined): void {
	if (!destination) return;
	try {
		destination.end();
	} catch {
		// The destination may already be broken (its file deleted) — it is
		// being discarded either way.
	}
}

function armMidnightRollover(logDir: string, level: string, now: Date): void {
	if (midnightTimer) clearTimeout(midnightTimer);
	const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
	midnightTimer = setTimeout(() => {
		void (async () => {
			const firedAt = new Date();
			await pruneOldLogs({ logDir, now: firedAt });
			// Swap FIRST so nothing new is written to the old file, then
			// release the old destination — end() flushes its buffer before
			// closing the fd, so no lines are lost and no fd leaks per day.
			const outgoing = currentDestination;
			const next = createFileLogger(logDir, level, firedAt);
			current = next.logger;
			currentDestination = next.destination;
			closeDestination(outgoing);
			armMidnightRollover(logDir, level, firedAt);
		})();
	}, nextDay.getTime() - now.getTime());
	midnightTimer.unref();
}

/** Process-wide logger. Silent no-op until `initLogger()` runs. */
export function getLogger(): Logger {
	return current;
}

/**
 * Test-only escape hatch: drop the process-wide logger back to the
 * disabled no-op and cancel the midnight timer. Without this, a logger
 * initialized against a test's temp dir keeps a sonic-boom destination
 * whose file the test's cleanup then deletes — the async open fails with
 * ENOENT and the next `getLogger().warn` in an unrelated test throws
 * `RangeError: fd out of range (-1)` on Linux CI.
 */
export function _resetLoggerForTests(): void {
	if (midnightTimer) {
		clearTimeout(midnightTimer);
		midnightTimer = undefined;
	}
	const outgoing = currentDestination;
	currentDestination = undefined;
	current = pino({ enabled: false });
	// Swallow async open errors on the outgoing sonic-boom destination.
	// When `sync: false`, the file open is asynchronous; if a test resets
	// and deletes its temp dir before that open completes, sonic-boom emits
	// an unhandled `error` event. Attaching a no-op listener prevents the
	// unhandled error from failing unrelated tests on CI.
	if (outgoing) {
		outgoing.on("error", () => {});
	}
	closeDestination(outgoing);
}

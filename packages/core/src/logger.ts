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
	current = createFileLogger(logDir, level, now);
	armMidnightRollover(logDir, level, now);
	return current;
}

function createFileLogger(logDir: string, level: string, now: Date): Logger {
	const destination = pino.destination({
		dest: join(logDir, `wenchat-${formatLogDate(now)}.log`),
		mkdir: true,
		sync: false,
	});
	return pino({ level }, destination);
}

function armMidnightRollover(logDir: string, level: string, now: Date): void {
	if (midnightTimer) clearTimeout(midnightTimer);
	const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
	midnightTimer = setTimeout(() => {
		void (async () => {
			const firedAt = new Date();
			await pruneOldLogs({ logDir, now: firedAt });
			current.flush();
			current = createFileLogger(logDir, level, firedAt);
			armMidnightRollover(logDir, level, firedAt);
		})();
	}, nextDay.getTime() - now.getTime());
	midnightTimer.unref();
}

/** Process-wide logger. Silent no-op until `initLogger()` runs. */
export function getLogger(): Logger {
	return current;
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CommandHistory } from "./commandHistory";

export const DEFAULT_HISTORY_FILE = join(homedir(), ".wechat", ".wechat_history");
export const DEFAULT_MAX_ENTRIES = 100;

export type HistoryStoreOptions = {
	filePath?: string;
	maxEntries?: number;
};

/**
 * Persistent command history. Wraps a {@link CommandHistory} with disk I/O:
 *
 * - On construction, reads `~/.wechat/.wechat_history` (or the supplied
 *   path). Missing or malformed files are tolerated — the store starts
 *   empty rather than crashing the CLI.
 * - After every successful `push`, writes the new entries atomically
 *   (write to `.tmp` then rename) so an interrupted write can't leave a
 *   half-written history file.
 * - Caps the in-memory + on-disk history at `maxEntries` (default 100),
 *   dropping the oldest entries when the cap is exceeded.
 */
export class HistoryStore {
	private readonly history: CommandHistory;
	private readonly filePath: string;
	private pendingWrites: Promise<void> = Promise.resolve();

	constructor(options: HistoryStoreOptions = {}) {
		const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.filePath = options.filePath ?? DEFAULT_HISTORY_FILE;
		this.history = new CommandHistory({ maxEntries });
		this.history.setOnChange(() => {
			// Chain onto the previous write so callers (and tests) can
			// `await flush()` to wait for all queued writes to settle.
			this.pendingWrites = this.pendingWrites
				.then(() => this.persist())
				.catch((err: unknown) => {
					console.error("[history] failed to persist:", err);
				});
		});
	}

	async init(): Promise<void> {
		const entries = await this.load();
		this.history.loadEntries(entries);
	}

	async flush(): Promise<void> {
		await this.pendingWrites;
	}

	prev(currentDraft: string): string | null {
		return this.history.prev(currentDraft);
	}

	next(): string | null {
		return this.history.next();
	}

	reset(): void {
		this.history.reset();
	}

	push(entry: string): void {
		this.history.push(entry);
	}

	get size(): number {
		return this.history.size;
	}

	private async load(): Promise<string[]> {
		try {
			const raw = await readFile(this.filePath, "utf-8");
			return decode(raw);
		} catch (err: unknown) {
			// ENOENT is expected on first run. Anything else is also non-fatal
			// — we start with empty history and let the next push recreate
			// the file.
			if (!isErrnoException(err)) {
				console.error("[history] failed to read history file:", err);
			}
			return [];
		}
	}

	private async persist(): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true });
		const encoded = encode(this.history.getEntries());
		const tmp = `${this.filePath}.tmp`;
		await writeFile(tmp, encoded, "utf-8");
		await rename(tmp, this.filePath);
	}
}

/**
 * Encode entries as newline-separated records, escaping embedded newlines
 * (`\n`) and backslashes (`\\`) so a single entry never spans multiple lines.
 */
function encode(entries: string[]): string {
	return entries.map(escapeEntry).join("\n") + (entries.length > 0 ? "\n" : "");
}

function escapeEntry(entry: string): string {
	return entry.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function decode(raw: string): string[] {
	if (raw.length === 0) return [];
	const out: string[] = [];
	let buf = "";
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (ch === "\\" && i + 1 < raw.length) {
			const next = raw[i + 1];
			if (next === "n") {
				buf += "\n";
				i++;
				continue;
			}
			if (next === "\\") {
				buf += "\\";
				i++;
				continue;
			}
		}
		if (ch === "\n") {
			out.push(buf);
			buf = "";
			continue;
		}
		buf += ch;
	}
	if (buf.length > 0) out.push(buf);
	return out;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
	return err instanceof Error && "code" in err;
}

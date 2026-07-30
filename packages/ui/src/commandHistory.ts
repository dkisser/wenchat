/**
 * Shell-style command history with readline-style recall semantics.
 *
 * - `push(entry)` records a submitted line. Adjacent duplicates are collapsed
 *   (so spamming Enter on the same line doesn't pollute history).
 * - `prev(currentDraft)` steps backward through history. On the first call it
 *   snapshots the user's draft so we can restore it when they walk forward
 *   past the newest entry. Returns null when the user is already at the
 *   oldest entry, so the caller can no-op.
 * - `next()` steps forward. Returns null when already at the draft.
 * - `reset()` clears the navigation cursor — used when the user starts typing
 *   a new line or after a submit.
 *
 * An optional `onChange` listener is invoked with the current entries after
 * each push (after the navigation cursor has been reset). Persistence layers
 * subscribe through this hook so the core class stays I/O-free.
 */
export class CommandHistory {
	private entries: string[] = [];
	private index = -1;
	private draft = "";
	private onChange?: (entries: string[]) => void;
	private maxEntries: number;

	constructor(options: { maxEntries?: number } = {}) {
		this.maxEntries = options.maxEntries ?? Number.POSITIVE_INFINITY;
	}

	get size(): number {
		return this.entries.length;
	}

	getEntries(): string[] {
		return [...this.entries];
	}

	setOnChange(listener: ((entries: string[]) => void) | undefined): void {
		this.onChange = listener;
	}

	loadEntries(entries: string[]): void {
		// Honor the cap when loading (e.g. a pre-existing file with more than
		// maxEntries lines — keep the most recent).
		const tail = entries.slice(-this.maxEntries);
		this.entries = [...tail];
		this.reset();
	}

	push(entry: string): void {
		const trimmed = entry.trim();
		if (trimmed.length === 0) return;
		const last = this.entries[this.entries.length - 1];
		if (entry === last) return;
		this.entries = [...this.entries, entry];
		// Drop oldest entries to honor the cap (FIFO).
		if (this.entries.length > this.maxEntries) {
			this.entries = this.entries.slice(this.entries.length - this.maxEntries);
		}
		this.reset();
		this.onChange?.(this.entries);
	}

	prev(currentDraft: string): string | null {
		if (this.entries.length === 0) return null;
		if (this.index === -1) {
			this.draft = currentDraft;
			this.index = this.entries.length - 1;
		} else if (this.index > 0) {
			this.index -= 1;
		} else {
			// Already at the oldest entry — stay put.
			return null;
		}
		return this.entries[this.index];
	}

	next(): string | null {
		if (this.index === -1) return null;
		if (this.index < this.entries.length - 1) {
			this.index += 1;
			return this.entries[this.index];
		}
		// At the newest entry — stepping past it returns the user's draft.
		this.index = -1;
		return this.draft;
	}

	reset(): void {
		this.index = -1;
		this.draft = "";
	}
}

import { readdir } from "node:fs/promises";
import { go } from "fuzzysort";
import { expandTilde } from "./expandTilde";

/**
 * One listable directory entry. Kept deliberately minimal — the fuzzy
 * filter only needs the name, and the picker only needs to know whether
 * accepting the entry descends (directory) or completes the path (file).
 */
export type FileCandidate = {
	readonly name: string;
	readonly isDirectory: boolean;
};

/** Injectable directory listing so tests never touch the real fs. */
export type DirLister = (dir: string) => Promise<FileCandidate[]>;

export type FilePartial = {
	/**
	 * Raw directory portion of the typed argument, trailing separator
	 * included ("" when the user has typed no separator yet). Preserved
	 * verbatim so an accepted candidate keeps the user's `~/` / relative
	 * spelling.
	 */
	readonly dirPart: string;
	/** The fragment after the last separator — what fuzzy matching runs on. */
	readonly baseName: string;
	/** `dirPart` with `~` expanded, ready to hand to a {@link DirLister}. */
	readonly expandedDir: string;
};

const FILE_COMMAND_PREFIX = "/file ";

/**
 * The argument of a `/file …` input line, or null when the input is not a
 * file command with at least the separating space typed. `/file` alone
 * returns null — that's still command-name territory for CommandSuggestion.
 */
export function fileCommandArg(input: string): string | null {
	if (!input.startsWith(FILE_COMMAND_PREFIX)) return null;
	return input.slice(FILE_COMMAND_PREFIX.length);
}

/**
 * Split a `/file` argument into the directory part and the basename
 * fragment being completed. Both `/` and `\` count as separators; the
 * directory part keeps the user's original spelling (tilde included) so an
 * accepted candidate can be spliced back without surprises.
 */
export function parseFilePartial(arg: string): FilePartial {
	const lastSep = Math.max(arg.lastIndexOf("/"), arg.lastIndexOf("\\"));
	const dirPart = lastSep === -1 ? "" : arg.slice(0, lastSep + 1);
	const baseName = lastSep === -1 ? arg : arg.slice(lastSep + 1);
	// No separator typed yet → complete against the process cwd, matching
	// how `/file foo` resolves at send time.
	const expandedDir = expandTilde(dirPart.length === 0 ? "." : dirPart);
	return { dirPart, baseName, expandedDir };
}

/**
 * Fuzzy-filter one directory listing against the typed basename.
 *
 * - Dotfiles stay hidden unless the query itself starts with a dot.
 * - An empty query lists everything (directories first, then alphabetical).
 * - Otherwise fuzzysort ranks the matches; directories are hoisted ahead of
 *   files while each group keeps its fuzzy-score order, because drilling
 *   into a directory is the common intermediate step.
 */
export function filterCandidates(
	entries: readonly FileCandidate[],
	baseName: string,
): FileCandidate[] {
	const visible = baseName.startsWith(".")
		? [...entries]
		: entries.filter((entry) => !entry.name.startsWith("."));
	if (baseName.length === 0) {
		return visible.sort((a, b) => {
			if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
	}
	// fuzzysort's default threshold drops sparse-but-legit matches (think
	// "dcmp" → "docker-compose.yml"); a generous floor keeps completion
	// useful on long kebab-case filenames while ranking still prefers
	// contiguous hits.
	const matched = go(baseName, visible, { key: "name", threshold: -10_000 }).map(
		(result) => result.obj,
	);
	// Stable partition — Array.sort stability keeps fuzzysort's score order
	// inside each group.
	return matched.sort((a, b) => {
		if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
		return 0;
	});
}

/**
 * The argument text after accepting a candidate: directories get a trailing
 * separator so completion continues into them, files complete the path and
 * end the completion session.
 */
export function buildAcceptedInput(dirPart: string, candidate: FileCandidate): string {
	return candidate.isDirectory ? `${dirPart}${candidate.name}/` : `${dirPart}${candidate.name}`;
}

/** Production lister: one `readdir` with dirent types, no sorting here. */
export const readdirLister: DirLister = async (dir) => {
	const dirents = await readdir(dir, { withFileTypes: true });
	return dirents.map((dirent) => ({
		name: dirent.name,
		isDirectory: dirent.isDirectory(),
	}));
};

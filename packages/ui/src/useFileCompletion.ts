import { useEffect, useMemo, useRef, useState } from "react";
import {
	type DirLister,
	type FileCandidate,
	buildAcceptedInput,
	fileCommandArg,
	filterCandidates,
	parseFilePartial,
	readdirLister,
} from "./fileCompletion";

/**
 * Key-routing surface handed to InputBox, plus the render state
 * FileSuggestion needs. `active` already accounts for dismissal and an
 * empty match set — when it's true there is at least one candidate and the
 * picker owns ↑/↓/Enter/Esc.
 */
export type FileCompletion = {
	readonly active: boolean;
	readonly candidates: readonly FileCandidate[];
	readonly selectedIndex: number;
	moveUp(): void;
	moveDown(): void;
	accept(): void;
	dismiss(): void;
};

export type UseFileCompletionOptions = {
	readonly input: string;
	readonly onChange: (next: string) => void;
	/** Overridable for tests; production uses {@link readdirLister}. */
	readonly lister?: DirLister;
};

/**
 * Live file completion for `/file <partial>` input.
 *
 * Directory listings are fetched once per expanded directory and cached —
 * per-keystroke narrowing is a synchronous fuzzy filter over the cache, so
 * typing never waits on the fs. A monotonic request id drops listings that
 * resolve after the user has already moved to another directory.
 *
 * Dismissal is tied to the exact input text it was taken on
 * (`dismissedFor`), so accepting a file (which rewrites the input) or
 * pressing Esc closes the picker, yet any further typing reopens it.
 */
export function useFileCompletion({
	input,
	onChange,
	lister = readdirLister,
}: UseFileCompletionOptions): FileCompletion {
	const arg = fileCommandArg(input);
	const partial = useMemo(() => (arg === null ? null : parseFilePartial(arg)), [arg]);

	const [dismissedFor, setDismissedFor] = useState<string | null>(null);
	const enabled = arg !== null && dismissedFor !== input;

	// The cached listing plus the directory it was fetched for. Entries are
	// only trusted while they match the current expandedDir — a listing for
	// the previous directory must never be filtered against the new basename.
	const [listing, setListing] = useState<{
		readonly dir: string;
		readonly entries: readonly FileCandidate[];
	}>({ dir: "", entries: [] });
	const requestRef = useRef(0);

	useEffect(() => {
		if (!enabled || partial === null) return;
		if (listing.dir === partial.expandedDir) return;
		const dir = partial.expandedDir;
		const requestId = ++requestRef.current;
		lister(dir).then(
			(entries) => {
				if (requestRef.current === requestId) setListing({ dir, entries });
			},
			() => {
				// Unreadable / missing directory: no candidates, picker stays
				// hidden, Enter submits and /file's own preflight reports it.
				if (requestRef.current === requestId) setListing({ dir, entries: [] });
			},
		);
	}, [enabled, partial, listing.dir, lister]);

	const entries = partial !== null && listing.dir === partial.expandedDir ? listing.entries : [];
	const candidates = useMemo(
		() => (partial === null ? [] : filterCandidates(entries, partial.baseName)),
		[entries, partial],
	);

	const [selectedIndex, setSelectedIndex] = useState(0);
	// Clamp rather than reset: narrowing the list keeps the selection on the
	// last row instead of jumping back to the top on every keystroke.
	useEffect(() => {
		setSelectedIndex((prev) => Math.min(prev, Math.max(candidates.length - 1, 0)));
	}, [candidates.length]);

	const active = enabled && candidates.length > 0;

	return {
		active,
		candidates,
		selectedIndex,
		moveUp() {
			setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
		},
		moveDown() {
			setSelectedIndex((prev) => (prev < candidates.length - 1 ? prev + 1 : prev));
		},
		accept() {
			if (partial === null) return;
			const candidate = candidates[selectedIndex];
			if (!candidate) return;
			const next = `/file ${buildAcceptedInput(partial.dirPart, candidate)}`;
			onChange(next);
			// A directory rewrites dirPart, which re-lists and keeps the picker
			// open; a file completes the path — close so the next Enter sends.
			if (!candidate.isDirectory) setDismissedFor(next);
		},
		dismiss() {
			setDismissedFor(input);
		},
	};
}

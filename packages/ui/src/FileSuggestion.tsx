import { Box, Text } from "ink";
import type { FileCandidate } from "./fileCompletion";
import { windowAround } from "./listWindow";

export type FileSuggestionProps = {
	readonly candidates: readonly FileCandidate[];
	readonly selectedIndex: number;
};

/**
 * Rows the picker can ever occupy: at most this many candidates between the
 * two border rows. Layout math (`CHROME_ROWS.fileSuggestion`) relies on
 * this cap, so keep the two in sync.
 */
export const FILE_SUGGESTION_MAX_ROWS = 4;

/**
 * Fuzzy file picker shown above the InputBox while a `/file <partial>`
 * command is being typed.
 *
 * The selected row is distinguished by inverse video alone — no `>` marker
 * — and directories carry a trailing `/` plus a distinct colour so a
 * glance tells accepting them descends rather than completes.
 */
export function FileSuggestion({ candidates, selectedIndex }: FileSuggestionProps) {
	if (candidates.length === 0) return null;

	const { start, end } = windowAround(candidates.length, FILE_SUGGESTION_MAX_ROWS, selectedIndex);
	const visible = candidates.slice(start, end);

	return (
		<Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} width="100%">
			{visible.map((candidate, index) => {
				const selected = start + index === selectedIndex;
				return (
					<Text
						key={candidate.name}
						inverse={selected}
						bold={selected}
						color={candidate.isDirectory ? "cyan" : undefined}
					>
						{candidate.isDirectory ? `${candidate.name}/` : candidate.name}
					</Text>
				);
			})}
		</Box>
	);
}

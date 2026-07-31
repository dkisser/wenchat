import { Box, Text } from "ink";
import { type CommandSpec, matchCommands } from "./magicCommands";

export type CommandSuggestionProps = {
	partial: string;
};

type ResolvedSuggestion = {
	readonly namePrefix: string;
	readonly matches: readonly CommandSpec[];
};

/**
 * Resolve what the suggestion row would show for the given input.
 *
 * Shared by the component and by {@link isCommandSuggestionVisible} so the
 * layout math and the actual render can never disagree about whether the row
 * occupies three terminal rows.
 */
function resolveSuggestion(partial: string): ResolvedSuggestion {
	if (!partial.startsWith("/")) return { namePrefix: "", matches: [] };

	// The part of the input that is currently the command name — strip the
	// leading `/` and any argument portion after the first space.
	const spaceIndex = partial.indexOf(" ");
	const namePrefix = spaceIndex === -1 ? partial.slice(1) : partial.slice(1, spaceIndex);

	return { namePrefix, matches: matchCommands(namePrefix) };
}

/**
 * True when {@link CommandSuggestion} renders a (bordered, three-row) box for
 * this input rather than `null`. The root layout needs this ahead of render to
 * decide how many rows are left for the chat viewport.
 */
export function isCommandSuggestionVisible(partial: string): boolean {
	return resolveSuggestion(partial).matches.length > 0;
}

/**
 * One-line suggestion row that appears above the InputBox whenever the
 * current input is a partial slash command. Renders nothing when the input
 * does not start with `/` or matches no commands.
 */
export function CommandSuggestion({ partial }: CommandSuggestionProps) {
	const { namePrefix, matches } = resolveSuggestion(partial);
	if (matches.length === 0) return null;

	return (
		<Box borderStyle="single" paddingX={1} borderColor="gray" width="100%">
			{matches.map((cmd, index) => (
				<Text key={cmd.name}>
					{index > 0 ? "   " : ""}
					<Text
						color={cmd.name === namePrefix && namePrefix.length > 0 ? "cyan" : "gray"}
						bold={cmd.name === namePrefix && namePrefix.length > 0}
					>
						{cmd.usage}
					</Text>
					<Text color="gray">{` — ${cmd.description}`}</Text>
				</Text>
			))}
		</Box>
	);
}

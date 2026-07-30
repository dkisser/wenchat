import { Box, Text } from "ink";
import { matchCommands } from "./magicCommands";

export type CommandSuggestionProps = {
	partial: string;
};

/**
 * One-line suggestion row that appears above the InputBox whenever the
 * current input is a partial slash command. Renders nothing when the input
 * does not start with `/` or matches no commands.
 */
export function CommandSuggestion({ partial }: CommandSuggestionProps) {
	if (!partial.startsWith("/")) return null;

	// The part of the input that is currently the command name — strip the
	// leading `/` and any argument portion after the first space.
	const spaceIndex = partial.indexOf(" ");
	const namePrefix = spaceIndex === -1 ? partial.slice(1) : partial.slice(1, spaceIndex);

	const matches = matchCommands(namePrefix);
	if (matches.length === 0) return null;

	return (
		<Box borderStyle="single" paddingX={1} borderColor="gray">
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

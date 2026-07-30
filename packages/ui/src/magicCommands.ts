export type CommandSpec = {
	name: string;
	description: string;
	usage: string;
};

export const MAGIC_COMMANDS: readonly CommandSpec[] = Object.freeze([
	{
		name: "exit",
		description: "quit the app",
		usage: "/exit",
	},
	{
		name: "file",
		description: "send a file to the connected peer",
		usage: "/file <path>",
	},
	{
		name: "help",
		description: "list all magic commands",
		usage: "/help",
	},
	{
		name: "connect",
		description: "connect to a peer manually",
		usage: "/connect <host:port>",
	},
]);

export type ParsedCommand = {
	name: string;
	arg: string;
};

/**
 * Parse a user input line into a magic command. Returns null when the input
 * is not a slash-prefixed command. The returned `name` is always the literal
 * text after the leading `/` (without validation against `MAGIC_COMMANDS` —
 * callers may want to render "unknown command" suggestions).
 */
export function parseCommand(input: string): ParsedCommand | null {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) return null;

	const spaceIndex = trimmed.indexOf(" ");
	const rawName = spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex);
	const arg = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();

	if (rawName.length === 0) return null;

	return { name: rawName, arg };
}

/**
 * Return the subset of MAGIC_COMMANDS whose name starts with `partialName`.
 * Useful for narrowing the suggestion popup as the user types.
 */
export function matchCommands(partialName: string): readonly CommandSpec[] {
	if (!partialName) return MAGIC_COMMANDS;
	const lower = partialName.toLowerCase();
	return MAGIC_COMMANDS.filter((cmd) => cmd.name.startsWith(lower));
}

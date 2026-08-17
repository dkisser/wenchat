import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Expand a leading `~` or `~/` to the user's home directory.
 * `~user` is intentionally not supported (no portable lookup); anything not
 * starting with a bare tilde is returned unchanged.
 */
export function expandTilde(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/") || input.startsWith("~\\")) {
		return join(homedir(), input.slice(2));
	}
	return input;
}

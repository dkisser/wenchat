import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { HistoryStore } from "./historyStore";
import { parseCommand, splitCommand } from "./magicCommands";

export type InputBoxProps = {
	value: string;
	onChange: (next: string) => void;
	onSubmit: (text: string) => void;
	onCommand: (name: string, arg: string) => void;
	onUnknownCommand: (name: string, arg: string) => void;
};

/**
 * Controlled single-line input with shell-style history recall.
 *
 * Behavior:
 * - Enter dispatches the line as before (command → onCommand/onUnknownCommand,
 *   plain text → onSubmit).
 * - Up / Ctrl+P recall the previous entry; Down / Ctrl+N go forward. Going
 *   past the newest entry restores the draft the user was typing before
 *   they started scrolling, mirroring bash/zsh/readline.
 * - History persists across sessions via {@link HistoryStore}, which reads
 *   from `~/.wechat/.wechat_history` on mount and writes back atomically
 *   after each submit.
 */
export function InputBox({
	value,
	onChange,
	onSubmit,
	onCommand,
	onUnknownCommand,
}: InputBoxProps) {
	const onChangeRef = useRef(onChange);
	useEffect(() => {
		onChangeRef.current = onChange;
	});

	// Blink the trailing caret on a fixed 500ms cadence. Ink hides the host
	// terminal's native blinking cursor on mount, so without this the input
	// has no visible caret at all.
	const [cursorVisible, setCursorVisible] = useState(true);
	useEffect(() => {
		const id = setInterval(() => setCursorVisible((v) => !v), 500);
		return () => clearInterval(id);
	}, []);

	const historyRef = useRef<HistoryStore | null>(null);
	if (historyRef.current === null) {
		historyRef.current = new HistoryStore();
		// Fire-and-forget load — first keypresses may happen before init
		// resolves, but `prev`/`next` are no-ops on empty history so that's
		// safe. The file load completes within a tick in practice.
		historyRef.current.init().catch((err: unknown) => {
			console.error("[history] init failed:", err);
		});
	}

	useInput((input, key) => {
		const history = historyRef.current;
		if (!history) return;

		const isUp = key.upArrow || (key.ctrl && input === "p");
		const isDown = key.downArrow || (key.ctrl && input === "n");

		if (isUp) {
			const recalled = history.prev(value);
			if (recalled !== null) onChangeRef.current(recalled);
			return;
		}

		if (isDown) {
			const recalled = history.next();
			if (recalled !== null) onChangeRef.current(recalled);
			return;
		}

		if (key.return) {
			if (value.length > 0) {
				const parsed = parseCommand(value);
				if (parsed) {
					const known = ["exit", "file", "help", "connect"];
					if (known.includes(parsed.name)) {
						onCommand(parsed.name, parsed.arg);
					} else {
						onUnknownCommand(parsed.name, parsed.arg);
					}
				} else if (value.trim().length > 0) {
					onSubmit(value);
				}
				history.push(value);
			}
			onChangeRef.current("");
			return;
		}

		if (key.backspace || key.delete) {
			onChangeRef.current(value.slice(0, -1));
			return;
		}

		if (!key.ctrl && !key.meta && input) {
			// Any new typing invalidates history browsing (matches readline).
			history.reset();
			onChangeRef.current(value + input);
		}
	});

	// Split the typed value into the prompt, the command name (if any), and
	// the argument so the command name can be highlighted independently. The
	// caret sits at the end of the value — the current input only supports
	// append / backspace, so cursor position is implicit.
	const { name: commandName, arg } = splitCommand(value);

	return (
		<Box borderStyle="single" paddingX={1}>
			<Text>{"> "}</Text>
			{commandName.length > 0 && (
				<Text color="cyan" bold>
					{commandName}
				</Text>
			)}
			<Text>{arg}</Text>
			<Text>{cursorVisible ? "▏" : " "}</Text>
		</Box>
	);
}

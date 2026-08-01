import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { HistoryStore } from "./historyStore";
import { matchCommands, parseCommand, splitCommand } from "./magicCommands";
import { stripMouseReports } from "./mouseEvents";

export type InputBoxProps = {
	value: string;
	onChange: (next: string) => void;
	onSubmit: (text: string) => void;
	onCommand: (name: string, arg: string) => void;
	onUnknownCommand: (name: string, arg: string) => void;
	/**
	 * Reported when persisted history fails to load. Never log to the console
	 * from here: ink patches `console.*` into `log.clear(); write; re-render`,
	 * which injects an arbitrary-height string into the fixed-height frame.
	 */
	onError?: (error: unknown) => void;
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
	onError,
}: InputBoxProps) {
	const onChangeRef = useRef(onChange);
	useEffect(() => {
		onChangeRef.current = onChange;
	});

	const onErrorRef = useRef(onError);
	useEffect(() => {
		onErrorRef.current = onError;
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
			onErrorRef.current?.(err);
		});
	}

	useInput((input, key) => {
		const history = historyRef.current;
		if (!history) return;

		// Shift+Arrow is reserved for scrolling the chat viewport, so history
		// recall only claims the unmodified arrows.
		const isUp = (key.upArrow && !key.shift) || (key.ctrl && input === "p");
		const isDown = (key.downArrow && !key.shift) || (key.ctrl && input === "n");

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

		if (key.tab) {
			// Tab is reserved for command-name completion. Only the leading
			// "/name" half is completed — once the user is typing an
			// argument we leave them alone (the path/host they're typing
			// has nothing to do with our command list).
			if (!value.startsWith("/")) return;
			const spaceIndex = value.indexOf(" ");
			if (spaceIndex !== -1) return;
			const partial = value.slice(1);
			if (partial.length === 0) return;
			const matches = matchCommands(partial);
			if (matches.length === 0) return;
			const candidate = matches[0];
			if (!candidate) return;
			if (partial === candidate.name) {
				// Already at the exact name — pressing Tab again invites the
				// argument with a single trailing space.
				onChangeRef.current(`${value} `);
				return;
			}
			onChangeRef.current(`/${candidate.name}`);
			return;
		}

		if (key.return) {
			if (value.length > 0) {
				const parsed = parseCommand(value);
				if (parsed) {
					const known = ["exit", "file", "help", "connect", "disconnect", "mouse"];
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
			// ink's key parser does not recognise SGR mouse reports (its
			// pattern requires `[` to be followed by a digit or a letter, and
			// ours starts with `<`), so every wheel tick would otherwise be
			// typed into the input. Strip rather than reject: a single stdin
			// chunk can carry both a keystroke and a wheel report.
			const typed = stripMouseReports(input);
			if (typed.length === 0) return;
			// Any new typing invalidates history browsing (matches readline).
			history.reset();
			onChangeRef.current(value + typed);
		}
	});

	// Split the typed value into the prompt, the command name (if any), and
	// the argument so the command name can be highlighted independently. The
	// caret sits at the end of the value — the current input only supports
	// append / backspace, so cursor position is implicit.
	const { name: commandName, arg } = splitCommand(value);

	return (
		<Box borderStyle="single" paddingX={1} width="100%">
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

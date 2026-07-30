import { Box, Text, useInput } from "ink";
import { useEffect, useRef } from "react";
import { parseCommand } from "./magicCommands";

export type InputBoxProps = {
	value: string;
	onChange: (next: string) => void;
	onSubmit: (text: string) => void;
	onCommand: (name: string, arg: string) => void;
	onUnknownCommand: (name: string, arg: string) => void;
};

/**
 * Controlled single-line input. Routes the line to one of three callbacks
 * when the user presses Enter:
 *   - `onCommand(name, arg)` for recognized magic commands (`/file`, `/exit`, etc.)
 *   - `onUnknownCommand(name, arg)` for `/`-prefixed lines with an unknown name
 *   - `onSubmit(text)` for plain (non-slash) messages
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

	useInput((input, key) => {
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
			}
			onChangeRef.current("");
			return;
		}

		if (key.backspace || key.delete) {
			onChangeRef.current(value.slice(0, -1));
			return;
		}

		if (!key.ctrl && !key.meta && input) {
			onChangeRef.current(value + input);
		}
	});

	return (
		<Box borderStyle="single" paddingX={1}>
			<Text>{`> ${value}`}</Text>
		</Box>
	);
}

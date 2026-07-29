import { Box, Text, useInput } from "ink";
import React, { useState } from "react";

export type InputBoxProps = {
	onSubmit: (text: string) => void;
	onFile: (path: string) => void;
};

export function InputBox({ onSubmit, onFile }: InputBoxProps) {
	const [text, setText] = useState("");

	useInput((input, key) => {
		if (key.return) {
			if (text.startsWith("/file ")) {
				onFile(text.slice(6).trim());
			} else if (text.trim().length > 0) {
				onSubmit(text);
			}
			setText("");
			return;
		}

		if (key.backspace || key.delete) {
			setText((prev) => prev.slice(0, -1));
			return;
		}

		if (!key.ctrl && !key.meta && input) {
			setText((prev) => prev + input);
		}
	});

	return (
		<Box borderStyle="single" paddingX={1}>
			<Text>{`> ${text}`}</Text>
		</Box>
	);
}

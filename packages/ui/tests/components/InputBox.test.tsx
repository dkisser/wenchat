import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import { InputBox } from "../../src/InputBox";

// Interactive history navigation is exercised by commandHistory.test.ts
// (the InputBox is just a thin shell over CommandHistory). Here we only
// verify the static rendering, which is what the existing component does
// in the absence of keyboard input.
describe("InputBox", () => {
	it("renders input prompt", () => {
		const { lastFrame } = render(
			<InputBox
				value=""
				onChange={() => {}}
				onSubmit={() => {}}
				onCommand={() => {}}
				onUnknownCommand={() => {}}
			/>,
		);
		expect(lastFrame()).toContain(">");
	});

	it("renders the current value", () => {
		const { lastFrame } = render(
			<InputBox
				value="hello"
				onChange={() => {}}
				onSubmit={() => {}}
				onCommand={() => {}}
				onUnknownCommand={() => {}}
			/>,
		);
		expect(lastFrame()).toContain("hello");
	});

	it("renders the command name when the input is a slash command", () => {
		const { lastFrame } = render(
			<InputBox
				value="/help"
				onChange={() => {}}
				onSubmit={() => {}}
				onCommand={() => {}}
				onUnknownCommand={() => {}}
			/>,
		);
		expect(lastFrame()).toContain("/help");
	});

	it("renders the command name and argument separately", () => {
		const { lastFrame } = render(
			<InputBox
				value="/file /etc/hosts"
				onChange={() => {}}
				onSubmit={() => {}}
				onCommand={() => {}}
				onUnknownCommand={() => {}}
			/>,
		);
		const frame = lastFrame();
		expect(frame).toContain("/file");
		expect(frame).toContain("/etc/hosts");
	});

	it("renders an unknown slash command verbatim", () => {
		const { lastFrame } = render(
			<InputBox
				value="/nope arg"
				onChange={() => {}}
				onSubmit={() => {}}
				onCommand={() => {}}
				onUnknownCommand={() => {}}
			/>,
		);
		expect(lastFrame()).toContain("/nope");
		expect(lastFrame()).toContain("arg");
	});

	it("draws a trailing caret on plain text", () => {
		const { lastFrame } = render(
			<InputBox
				value="hello"
				onChange={() => {}}
				onSubmit={() => {}}
				onCommand={() => {}}
				onUnknownCommand={() => {}}
			/>,
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("hello");
		// Either the visible quarter-block cursor or its hidden-space
		// alternate appears at the end of the prompt.
		expect(frame.includes("▏") || /hello\s$/.test(frame)).toBe(true);
	});
});

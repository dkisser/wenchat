import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import { InputBox } from "./InputBox";

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
});

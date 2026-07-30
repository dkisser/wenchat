import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import { InputBox } from "./InputBox";

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

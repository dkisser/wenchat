import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import { InputBox } from "./InputBox";

describe("InputBox", () => {
	it("renders input prompt", () => {
		const { lastFrame } = render(<InputBox onSubmit={() => {}} onFile={() => {}} />);
		expect(lastFrame()).toContain(">");
	});
});

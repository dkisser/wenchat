import { render } from "ink-testing-library";
import { describe, expect, it } from "bun:test";
import React from "react";
import { InputBox } from "./InputBox.tsx";

describe("InputBox", () => {
	it("renders input prompt", () => {
		const { lastFrame } = render(
			<InputBox onSubmit={() => {}} onFile={() => {}} />,
		);
		expect(lastFrame()).toContain(">");
	});
});

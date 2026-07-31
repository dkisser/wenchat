import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "../src/App";

describe("App", () => {
	it("renders status bar", () => {
		const { lastFrame } = render(
			<App displayName="alice" signalingPort={19001} signalingHost="127.0.0.1" />,
		);
		expect(lastFrame()).toContain("Offline");
	});

	it("keeps the input box as the last visible row", () => {
		// The reported bug: the input box scrolled off screen once the chat
		// log outgrew the terminal. With a fixed frame height, the InputBox
		// must always be the last frame row — its bottom border is the very
		// last line.
		const { lastFrame } = render(
			<App displayName="alice" signalingPort={19001} signalingHost="127.0.0.1" />,
		);
		const frame = lastFrame() ?? "";
		const lastLine = frame.split("\n").at(-1) ?? "";
		expect(lastLine.startsWith("└")).toBe(true);
		expect(lastLine.endsWith("┘")).toBe(true);
	});
});

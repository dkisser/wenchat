import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import { CommandSuggestion } from "./CommandSuggestion";

describe("CommandSuggestion", () => {
	it("renders nothing when input is not a slash command", () => {
		const { lastFrame } = render(<CommandSuggestion partial="hello" />);
		expect(lastFrame()).not.toContain("/exit");
		expect(lastFrame()).not.toContain("/file");
	});

	it("renders nothing when input is empty", () => {
		const { lastFrame } = render(<CommandSuggestion partial="" />);
		expect(lastFrame()).not.toContain("/exit");
	});

	it("renders all commands when partial is just a slash", () => {
		const { lastFrame } = render(<CommandSuggestion partial="/" />);
		const frame = lastFrame();
		expect(frame).toContain("/exit");
		expect(frame).toContain("/file");
		expect(frame).toContain("/help");
		expect(frame).toContain("/connect");
	});

	it("filters commands by prefix", () => {
		const { lastFrame } = render(<CommandSuggestion partial="/fi" />);
		const frame = lastFrame();
		expect(frame).toContain("/file");
		expect(frame).not.toContain("/exit");
		expect(frame).not.toContain("/help");
	});

	it("renders nothing when prefix matches no command", () => {
		const { lastFrame } = render(<CommandSuggestion partial="/zzz" />);
		expect(lastFrame()).not.toContain("/exit");
	});

	it("shows the description for each command", () => {
		const { lastFrame } = render(<CommandSuggestion partial="/" />);
		const frame = lastFrame();
		expect(frame).toContain("quit");
		expect(frame).toContain("list");
		expect(frame).toContain("send");
		expect(frame).toContain("manual");
	});
});

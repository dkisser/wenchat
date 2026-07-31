import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import { ChatView } from "../../src/ChatView";

describe("ChatView", () => {
	it("renders text messages", () => {
		const messages = [
			{
				type: "text" as const,
				id: "local-1",
				timestamp: 0,
				payload: { text: "hi" },
			},
		];
		const { lastFrame } = render(<ChatView messages={messages} localId="local" />);
		expect(lastFrame()).toContain("hi");
	});

	it("renders system messages with [system] prefix", () => {
		const messages = [
			{
				type: "text" as const,
				id: "system-abc-123",
				timestamp: 0,
				payload: { text: "Connected to bob" },
			},
		];
		const { lastFrame } = render(<ChatView messages={messages} localId="local" />);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("[system]");
		expect(frame).toContain("Connected to bob");
	});
});

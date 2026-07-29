import { render } from "ink-testing-library";
import { describe, expect, it } from "bun:test";
import React from "react";
import { ChatView } from "./ChatView.tsx";

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
		const { lastFrame } = render(
			<ChatView messages={messages} localId="local" />,
		);
		expect(lastFrame()).toContain("hi");
	});
});

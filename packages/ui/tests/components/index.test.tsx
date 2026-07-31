import { describe, expect, it } from "bun:test";
import {
	ChatView,
	CommandSuggestion,
	InputBox,
	PeerList,
	StatusBar,
	parseCommand,
} from "../../src/index";

describe("ui index exports", () => {
	it("exports all components", () => {
		expect(ChatView).toBeDefined();
		expect(CommandSuggestion).toBeDefined();
		expect(InputBox).toBeDefined();
		expect(PeerList).toBeDefined();
		expect(StatusBar).toBeDefined();
	});

	it("exports magic command helpers", () => {
		expect(typeof parseCommand).toBe("function");
	});
});

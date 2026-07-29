import { describe, expect, it } from "bun:test";
import { ChatView, InputBox, PeerList, StatusBar } from "./index.tsx";

describe("ui index exports", () => {
	it("exports all components", () => {
		expect(ChatView).toBeDefined();
		expect(InputBox).toBeDefined();
		expect(PeerList).toBeDefined();
		expect(StatusBar).toBeDefined();
	});
});

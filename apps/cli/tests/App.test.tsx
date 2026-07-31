import type { Message } from "@wenchat/protocol";
import { render } from "ink-testing-library";
import { describe, expect, it } from "bun:test";
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

	it("renders ChatView (not PeerList) when initialMessages is non-empty even while offline", () => {
		// After a remote /exit, the non-exiting side goes to status="offline"
		// but the chat history must stay on screen. The render branch is
		// `status === "offline" && messages.length === 0 ? <PeerList/> :
		// <ChatView/>`; this test seeds the log so messages.length > 0 and
		// asserts ChatView wins.
		const seed: Message[] = [
			{
				type: "text",
				id: "seed-1",
				timestamp: Date.now(),
				payload: { text: "previously sent message" },
			},
		];
		const { lastFrame } = render(
			<App
				displayName="alice"
				signalingPort={19001}
				signalingHost="127.0.0.1"
				initialMessages={seed}
			/>,
		);
		const frame = lastFrame() ?? "";
		// ChatView renders the seed body — proves the chat view mounted.
		expect(frame).toContain("previously sent message");
		// PeerList's empty-state string is unique to that component; its
		// absence proves the peer list did not render.
		expect(frame).not.toContain("No peers found");
	});
});

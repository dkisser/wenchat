import { describe, expect, it } from "bun:test";
import type { Message } from "@wenchat/protocol";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { useChatScroll } from "../../src/useChatScroll";

const ESC = "\u001B";
const WHEEL_UP = `${ESC}[<64;10;5M`;
const WHEEL_DOWN = `${ESC}[<65;10;5M`;
const PAGE_UP = `${ESC}[5~`;
const PAGE_DOWN = `${ESC}[6~`;
const SHIFT_UP = `${ESC}[1;2A`;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function log(count: number, from = 0): Message[] {
	return Array.from({ length: count }, (_, index) => ({
		type: "text" as const,
		id: `local-${from + index}`,
		timestamp: 0,
		payload: { text: `m${from + index}` },
	}));
}

type ProbeProps = {
	readonly messages: readonly Message[];
	readonly viewportHeight?: number;
	readonly isActive?: boolean;
};

function Probe({ messages, viewportHeight = 5, isActive = true }: ProbeProps) {
	const { visibleLines, unread, atBottom } = useChatScroll({
		messages,
		localId: "local",
		names: { local: "local" },
		contentWidth: 40,
		viewportHeight,
		isActive,
	});
	return <Text>{`${visibleLines.join(",")}|unread=${unread}|bottom=${atBottom}`}</Text>;
}

// Display lines carry a styled "HH:mm  name  " prefix; assertions target the
// message bodies (`mNN`), which the prefixes never contain.
const expectWindow = (frame: string, from: number, to: number) => {
	for (let i = from; i <= to; i++) {
		expect(frame).toContain(`m${i}`);
	}
};

describe("useChatScroll", () => {
	it("shows the newest lines by default", async () => {
		const { lastFrame } = render(<Probe messages={log(20)} />);
		await tick();
		const frame = lastFrame() ?? "";
		// Bottom 5 lines = blank, m17, blank, m18, blank, m19 — actually 5
		// rows so 3 messages (inter-message blank rows eat ~half the view).
		expectWindow(frame, 17, 19);
		expect(frame).not.toContain("m14");
		expect(frame).toContain("bottom=true");
	});

	it("scrolls up three lines per wheel tick", async () => {
		const { lastFrame, stdin } = render(<Probe messages={log(20)} />);
		await tick();

		stdin.write(WHEEL_UP);
		await tick();

		const frame = lastFrame() ?? "";
		// Three lines up from the bottom = blank, m16, blank, m17, blank.
		expectWindow(frame, 16, 17);
		expect(frame).not.toContain("m18");
		expect(frame).toContain("bottom=false");
	});

	it("scrolls back down and re-follows the tail", async () => {
		const { lastFrame, stdin } = render(<Probe messages={log(20)} />);
		await tick();

		stdin.write(WHEEL_UP);
		await tick();
		stdin.write(WHEEL_DOWN);
		await tick();

		expect(lastFrame()).toContain("m19");
		expect(lastFrame()).toContain("bottom=true");
	});

	it("stays put and counts unread when messages arrive while scrolled up", async () => {
		const { lastFrame, stdin, rerender } = render(<Probe messages={log(20)} />);
		await tick();

		stdin.write(WHEEL_UP);
		await tick();
		const beforeAppend = lastFrame();

		rerender(<Probe messages={[...log(20), ...log(2, 20)]} />);
		await tick();

		// Same scrolled-up window as before appending — only the unread
		// counter changes. Inter-message blanks keep the window to 2 msgs.
		expectWindow(lastFrame() ?? "", 16, 17);
		expect(lastFrame()).toContain("unread=2");
		expect(beforeAppend).toContain("unread=0");
	});

	it("keeps following the tail when messages arrive at the bottom", async () => {
		const { lastFrame, rerender } = render(<Probe messages={log(20)} />);
		await tick();

		rerender(<Probe messages={[...log(20), ...log(2, 20)]} />);
		await tick();

		expect(lastFrame()).toContain("m21");
		expect(lastFrame()).toContain("unread=0");
	});

	it("clears the unread badge once the user scrolls back to the bottom", async () => {
		const { lastFrame, stdin, rerender } = render(<Probe messages={log(20)} />);
		await tick();

		stdin.write(WHEEL_UP);
		await tick();
		rerender(<Probe messages={[...log(20), ...log(2, 20)]} />);
		await tick();
		expect(lastFrame()).toContain("unread=2");

		for (let i = 0; i < 5; i++) {
			stdin.write(WHEEL_DOWN);
			await tick();
		}

		expect(lastFrame()).toContain("unread=0");
		expect(lastFrame()).toContain("bottom=true");
	});

	it("pages with PageUp / PageDown", async () => {
		const { lastFrame, stdin } = render(<Probe messages={log(30)} />);
		await tick();

		stdin.write(PAGE_UP);
		await tick();
		// viewportHeight 5 → a page is 4 lines, so from the bottom (m27/28/29)
		// PageUp lands on the prior 4-line window: blank, m25, blank, m26, m27.
		expectWindow(lastFrame() ?? "", 25, 27);

		stdin.write(PAGE_DOWN);
		await tick();
		expect(lastFrame()).toContain("m29");
	});

	it("scrolls one line with Shift+Up", async () => {
		const { lastFrame, stdin } = render(<Probe messages={log(20)} />);
		await tick();

		stdin.write(SHIFT_UP);
		await tick();

		// Bottom viewport (lines 34–38) shifted up by 1 = lines 33–37 =
		// blank, m17, blank, m18, blank — 2 messages, same scroll distance.
		expectWindow(lastFrame() ?? "", 17, 18);
	});

	it("ignores scroll input while inactive", async () => {
		const { lastFrame, stdin } = render(<Probe messages={log(20)} isActive={false} />);
		await tick();

		stdin.write(WHEEL_UP);
		stdin.write(PAGE_UP);
		await tick();

		expect(lastFrame()).toContain("m19");
	});

	it("re-clamps when the message log is trimmed underneath it", async () => {
		const { lastFrame, stdin, rerender } = render(<Probe messages={log(40)} />);
		await tick();

		for (let i = 0; i < 5; i++) {
			stdin.write(WHEEL_UP);
			await tick();
		}
		expect(lastFrame()).toContain("bottom=false");

		rerender(<Probe messages={log(6)} />);
		await tick();

		expect(lastFrame()).toContain("bottom=true");
		expect(lastFrame()).toContain("m5");
	});
});

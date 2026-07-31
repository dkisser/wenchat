import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import { ChatView } from "../../src/ChatView";

const frameLines = (frame: string | undefined) => (frame ?? "").split("\n");

describe("ChatView", () => {
	it("renders the lines it is given", () => {
		const { lastFrame } = render(<ChatView lines={["[me] hi", "[peer] yo"]} />);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("[me] hi");
		expect(frame).toContain("[peer] yo");
	});

	it("occupies exactly the height it is given", () => {
		const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
		const { lastFrame } = render(<ChatView lines={lines.slice(0, 8)} height={10} />);
		expect(frameLines(lastFrame()).length).toBe(10);
	});

	it("keeps its height even when the lines do not fill the viewport", () => {
		const { lastFrame } = render(<ChatView lines={["only one"]} height={10} />);
		expect(frameLines(lastFrame()).length).toBe(10);
	});

	it("still gives a blank display line its own row", () => {
		// An empty <Text> renders zero rows in ink, which would silently
		// shrink the frame — blank lines must be emitted as a space.
		const { lastFrame } = render(<ChatView lines={["a", "", "b"]} height={5} />);
		const inner = frameLines(lastFrame()).slice(1, -1);
		expect(inner.length).toBe(3);
		expect(inner[0]).toContain("a");
		expect(inner[2]).toContain("b");
	});

	it("shows a pluralised unread indicator", () => {
		const lines = Array.from({ length: 3 }, (_, i) => `line ${i}`);
		expect(lastFrameOf(<ChatView lines={lines} height={5} unread={3} />)).toContain(
			"3 new messages",
		);
		expect(lastFrameOf(<ChatView lines={lines} height={5} unread={1} />)).toContain(
			"1 new message",
		);
	});

	it("replaces the last visible line with the indicator rather than growing", () => {
		const lines = ["a", "b", "c"];
		const withIndicator = render(<ChatView lines={lines} height={5} unread={2} />);
		const frame = withIndicator.lastFrame() ?? "";

		expect(frameLines(frame).length).toBe(5);
		expect(frame).toContain("a");
		expect(frame).toContain("b");
		expect(frame).not.toContain("c");
	});

	it("renders no indicator when nothing is unread", () => {
		const { lastFrame } = render(<ChatView lines={["a"]} height={5} unread={0} />);
		expect(lastFrame()).not.toContain("new message");
	});

	it("grows to fit when no height is given (non-TTY / test rendering)", () => {
		const { lastFrame } = render(<ChatView lines={["a", "b", "c"]} />);
		expect(frameLines(lastFrame()).length).toBe(5);
	});
});

function lastFrameOf(element: React.ReactElement): string {
	return render(element).lastFrame() ?? "";
}

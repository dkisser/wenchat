import { describe, expect, it } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { useMouseWheel } from "../../src/useMouseWheel";

const ESC = "\u001B";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Module-level sink so the probe stays a one-liner and survives re-renders. */
const received: string[] = [];

function Probe({ isActive }: { isActive?: boolean }) {
	useMouseWheel((direction) => received.push(direction), { isActive });
	return <Text>probe</Text>;
}

describe("useMouseWheel", () => {
	it("reports wheel-up and wheel-down ticks", async () => {
		const { stdin } = render(<Probe />);
		await tick();
		received.length = 0;

		stdin.write(`${ESC}[<64;10;5M`);
		stdin.write(`${ESC}[<65;10;5M`);
		await tick();

		expect(received).toEqual(["up", "down"]);
	});

	it("ignores non-wheel reports and ordinary typing", async () => {
		const { stdin } = render(<Probe />);
		await tick();
		received.length = 0;

		stdin.write("hello");
		stdin.write(`${ESC}[<0;3;4M`);
		await tick();

		expect(received).toEqual([]);
	});

	it("reassembles a report split across two reads", async () => {
		const { stdin } = render(<Probe />);
		await tick();
		received.length = 0;

		stdin.write(`${ESC}[<64;10`);
		await tick();
		expect(received).toEqual([]);

		stdin.write(";5M");
		await tick();
		expect(received).toEqual(["up"]);
	});

	it("stays quiet while inactive", async () => {
		const { stdin } = render(<Probe isActive={false} />);
		await tick();
		received.length = 0;

		stdin.write(`${ESC}[<64;10;5M`);
		await tick();

		expect(received).toEqual([]);
	});

	it("unsubscribes on unmount", async () => {
		const { stdin, unmount } = render(<Probe />);
		await tick();

		unmount();
		await tick();
		received.length = 0;

		stdin.write(`${ESC}[<64;10;5M`);
		await tick();
		expect(received).toEqual([]);
	});
});

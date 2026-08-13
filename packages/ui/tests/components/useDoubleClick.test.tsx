import { describe, expect, it } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { useDoubleClick } from "../../src/useDoubleClick";

const ESC = "";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

type Hit = { readonly col: number; readonly row: number };
const received: Hit[] = [];

function Probe({
	isActive,
	windowMs,
}: {
	isActive?: boolean;
	windowMs?: number;
}) {
	useDoubleClick(
		(col, row) => {
			received.push({ col, row });
		},
		{ isActive, windowMs },
	);
	return <Text>probe</Text>;
}

function clear(): void {
	received.length = 0;
}

describe("useDoubleClick", () => {
	it("fires on two left-button presses within the window at the same cell", async () => {
		const { stdin } = render(<Probe />);
		await tick();
		clear();

		stdin.write(`${ESC}[<0;10;5M`); // left press at col 10, row 5
		await tick();
		stdin.write(`${ESC}[<0;10;5M`); // second press at same cell
		await tick();

		expect(received).toEqual([{ col: 10, row: 5 }]);
	});

	it("does not fire on two presses at different cells", async () => {
		const { stdin } = render(<Probe />);
		await tick();
		clear();

		stdin.write(`${ESC}[<0;10;5M`);
		await tick();
		stdin.write(`${ESC}[<0;11;5M`); // different row
		await tick();

		expect(received).toEqual([]);
	});

	it("does not fire when the second press arrives after the window expires", async () => {
		const { stdin } = render(<Probe windowMs={20} />);
		await tick();
		clear();

		stdin.write(`${ESC}[<0;10;5M`);
		await tick();
		// Wait past the 20ms window.
		await new Promise((r) => setTimeout(r, 40));
		stdin.write(`${ESC}[<0;10;5M`);
		await tick();

		expect(received).toEqual([]);
	});

	it("ignores right-button (buttonCode 2) presses", async () => {
		const { stdin } = render(<Probe />);
		await tick();
		clear();

		stdin.write(`${ESC}[<2;10;5M`);
		await tick();
		stdin.write(`${ESC}[<2;10;5M`);
		await tick();

		expect(received).toEqual([]);
	});

	it("ignores middle-button (buttonCode 1) presses", async () => {
		const { stdin } = render(<Probe />);
		await tick();
		clear();

		stdin.write(`${ESC}[<1;10;5M`);
		await tick();
		stdin.write(`${ESC}[<1;10;5M`);
		await tick();

		expect(received).toEqual([]);
	});

	it("ignores release events and only counts presses", async () => {
		const { stdin } = render(<Probe />);
		await tick();
		clear();

		// press + release + press + release — the two presses should fire.
		stdin.write(`${ESC}[<0;10;5M`);
		stdin.write(`${ESC}[<0;10;5m`); // release ('m', lowercase)
		stdin.write(`${ESC}[<0;10;5M`);
		stdin.write(`${ESC}[<0;10;5m`);
		await tick();

		expect(received).toEqual([{ col: 10, row: 5 }]);
	});

	it("ignores wheel reports even when their coords would otherwise match", async () => {
		const { stdin } = render(<Probe />);
		await tick();
		clear();

		// Wheel-up has buttonCode 64 (wheel flag) | 0 (button 0).
		// Our filter: `button !== "other"` discards wheel events.
		stdin.write(`${ESC}[<64;10;5M`);
		await tick();
		stdin.write(`${ESC}[<64;10;5M`);
		await tick();

		expect(received).toEqual([]);
	});

	it("stays quiet while inactive", async () => {
		const { stdin } = render(<Probe isActive={false} />);
		await tick();
		clear();

		stdin.write(`${ESC}[<0;10;5M`);
		await tick();
		stdin.write(`${ESC}[<0;10;5M`);
		await tick();

		expect(received).toEqual([]);
	});

	it("requires a fresh pair after a fire (no triple-click chaining)", async () => {
		const { stdin } = render(<Probe />);
		await tick();
		clear();

		// Three presses in a row: only one double-click should fire.
		stdin.write(`${ESC}[<0;10;5M`);
		await tick();
		stdin.write(`${ESC}[<0;10;5M`); // second press → fires
		await tick();
		stdin.write(`${ESC}[<0;10;5M`); // third press — but lastPress was reset
		await tick();

		expect(received.length).toBe(1);
		expect(received[0]).toEqual({ col: 10, row: 5 });
	});
});

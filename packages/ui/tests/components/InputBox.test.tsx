import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import { InputBox } from "../../src/InputBox";

const ESC = "\u001B";

// Interactive history navigation is exercised by commandHistory.test.ts
// (the InputBox is just a thin shell over CommandHistory). Here we only
// verify the static rendering, which is what the existing component does
// in the absence of keyboard input.
describe("InputBox", () => {
	it("renders input prompt", () => {
		const { lastFrame } = render(
			<InputBox value="" onChange={() => {}} onSubmit={() => {}} onCommand={() => {}} />,
		);
		expect(lastFrame()).toContain("❯");
	});

	it("draws only top and bottom rules — no vertical border lines", () => {
		const { lastFrame } = render(
			<InputBox value="hello" onChange={() => {}} onSubmit={() => {}} onCommand={() => {}} />,
		);
		const rows = (lastFrame() ?? "").split("\n");
		expect(rows.length).toBe(3);
		expect(rows[0]?.trim()).toMatch(/^─+$/);
		expect(rows[2]?.trim()).toMatch(/^─+$/);
		const frame = lastFrame() ?? "";
		for (const ch of ["│", "┌", "┐", "└", "┘"]) {
			expect(frame).not.toContain(ch);
		}
	});

	it("renders the current value", () => {
		const { lastFrame } = render(
			<InputBox value="hello" onChange={() => {}} onSubmit={() => {}} onCommand={() => {}} />,
		);
		expect(lastFrame()).toContain("hello");
	});

	it("renders the command name when the input is a slash command", () => {
		const { lastFrame } = render(
			<InputBox value="/help" onChange={() => {}} onSubmit={() => {}} onCommand={() => {}} />,
		);
		expect(lastFrame()).toContain("/help");
	});

	it("renders the command name and argument separately", () => {
		const { lastFrame } = render(
			<InputBox
				value="/file /etc/hosts"
				onChange={() => {}}
				onSubmit={() => {}}
				onCommand={() => {}}
			/>,
		);
		const frame = lastFrame();
		expect(frame).toContain("/file");
		expect(frame).toContain("/etc/hosts");
	});

	it("renders an unknown slash command verbatim", () => {
		const { lastFrame } = render(
			<InputBox value="/nope arg" onChange={() => {}} onSubmit={() => {}} onCommand={() => {}} />,
		);
		expect(lastFrame()).toContain("/nope");
		expect(lastFrame()).toContain("arg");
	});

	it("draws a trailing caret on plain text", () => {
		const { lastFrame } = render(
			<InputBox value="hello" onChange={() => {}} onSubmit={() => {}} onCommand={() => {}} />,
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("hello");
		// Either the visible quarter-block cursor or its hidden-space
		// alternate appears at the end of the prompt.
		expect(frame.includes("▏") || /hello\s$/.test(frame)).toBe(true);
	});
});

// These few tests drive stdin directly, breaking the convention above. They
// have to: mouse reports and Shift+Arrow are byte-level interactions between
// two independent useInput consumers, which no pure helper test can observe.
describe("InputBox keyboard/mouse arbitration", () => {
	const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

	type Harness = {
		readonly changes: string[];
		readonly stdin: { write: (data: string) => void };
	};

	function mount(value = ""): Harness {
		const changes: string[] = [];
		const { stdin } = render(
			<InputBox
				value={value}
				onChange={(next) => changes.push(next)}
				onSubmit={() => {}}
				onCommand={() => {}}
			/>,
		);
		return { changes, stdin };
	}

	it("does not type a mouse wheel report into the input", async () => {
		// Regression test for the reported bug: ink's key parser does not
		// recognise `ESC [ < … M`, so the raw bytes used to land in the value.
		const { changes, stdin } = mount();
		await tick();

		stdin.write(`${ESC}[<64;10;5M`);
		await tick();

		expect(changes).toEqual([]);
	});

	it("keeps the keystroke when a chunk carries both typing and a wheel tick", async () => {
		const { changes, stdin } = mount();
		await tick();

		stdin.write(`a${ESC}[<64;10;5M`);
		await tick();

		expect(changes).toEqual(["a"]);
	});

	it("leaves Shift+Up to the chat viewport instead of recalling history", async () => {
		const { changes, stdin } = mount();
		await tick();

		stdin.write(`${ESC}[1;2A`);
		stdin.write(`${ESC}[1;2B`);
		await tick();

		expect(changes).toEqual([]);
	});

	it("still recalls history on a plain Up arrow", async () => {
		const { changes, stdin } = mount("draft");
		await tick();

		// One submit puts an entry into history, then Up recalls it.
		stdin.write("x");
		await tick();
		stdin.write("\r");
		await tick();
		changes.length = 0;

		stdin.write(`${ESC}[A`);
		await tick();

		expect(changes).toEqual(["draft"]);
	});
});

describe("InputBox Tab completion", () => {
	const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

	function mountWith(value: string): {
		readonly changes: string[];
		readonly stdin: { write: (data: string) => void };
	} {
		const changes: string[] = [];
		const { stdin } = render(
			<InputBox
				value={value}
				onChange={(next) => changes.push(next)}
				onSubmit={() => {}}
				onCommand={() => {}}
			/>,
		);
		return { changes, stdin };
	}

	// ink's key parser decodes a Tab keypress as the byte 0x09. We send
	// it raw rather than as a control sequence so the test stays close to
	// what the TTY actually delivers.
	const TAB = "\t";

	it("completes a partial command to the first match", async () => {
		const { changes, stdin } = mountWith("/f");
		await tick();

		stdin.write(TAB);
		await tick();

		expect(changes).toEqual(["/file"]);
	});

	it("completes a longer partial unambiguously", async () => {
		const { changes, stdin } = mountWith("/co");
		await tick();

		stdin.write(TAB);
		await tick();

		expect(changes).toEqual(["/connect"]);
	});

	it("appends a space when the name is already exact", async () => {
		// `/file` then Tab should give `/file ` so the user can start
		// typing the path. This mirrors how shells add a trailing space
		// when a completion is unambiguous and the argument slot is empty.
		const { changes, stdin } = mountWith("/file");
		await tick();

		stdin.write(TAB);
		await tick();

		expect(changes).toEqual(["/file "]);
	});

	it("does nothing when no command matches the partial", async () => {
		const { changes, stdin } = mountWith("/zzz");
		await tick();

		stdin.write(TAB);
		await tick();

		expect(changes).toEqual([]);
	});

	it("does nothing for plain (non-slash) input", async () => {
		const { changes, stdin } = mountWith("hello");
		await tick();

		stdin.write(TAB);
		await tick();

		expect(changes).toEqual([]);
	});

	it("does nothing once the user is already typing an argument", async () => {
		// `/file /etc/hosts` then Tab — the user is past the command
		// name, so Tab should be a no-op. The CommandSuggestion popup
		// hides itself once a space appears, so we don't have any UI to
		// dim; the test just asserts the value stays put.
		const { changes, stdin } = mountWith("/file /etc/hosts");
		await tick();

		stdin.write(TAB);
		await tick();

		expect(changes).toEqual([]);
	});

	it("completes /disconnect from /d", async () => {
		const { changes, stdin } = mountWith("/d");
		await tick();

		stdin.write(TAB);
		await tick();

		expect(changes).toEqual(["/disconnect"]);
	});

	it("completes /mouse from /m", async () => {
		const { changes, stdin } = mountWith("/m");
		await tick();

		stdin.write(TAB);
		await tick();

		expect(changes).toEqual(["/mouse"]);
	});
});

describe("InputBox Enter dispatch", () => {
	const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

	type DispatchCapture = {
		readonly submits: string[];
		readonly commands: ReadonlyArray<readonly [string, string]>;
		readonly stdin: { write: (data: string) => void };
	};

	function mountWith(value: string): DispatchCapture {
		const submits: string[] = [];
		const commands: Array<[string, string]> = [];
		const { stdin } = render(
			<InputBox
				value={value}
				onChange={() => {}}
				onSubmit={(text) => submits.push(text)}
				onCommand={(name, arg) => commands.push([name, arg])}
			/>,
		);
		return { submits, commands, stdin };
	}

	// Carriage return is what ink's key parser sees as the Enter key.
	const CR = "\r";

	it("dispatches known commands via onCommand", async () => {
		const { submits, commands, stdin } = mountWith("/file /etc/hosts");
		await tick();

		stdin.write(CR);
		await tick();

		expect(commands).toEqual([["file", "/etc/hosts"]]);
		expect(submits).toEqual([]);
	});

	it("sends absolute paths as plain text via onSubmit", async () => {
		// Regression for the reported bug: paths like
		// /Users/wenchen/workspace/yhh/claw-yhh/.venv/bin/python used to
		// be misidentified as slash commands and silently dropped.
		const { submits, commands, stdin } = mountWith(
			"/Users/wenchen/workspace/yhh/claw-yhh/.venv/bin/python",
		);
		await tick();

		stdin.write(CR);
		await tick();

		expect(submits).toEqual(["/Users/wenchen/workspace/yhh/claw-yhh/.venv/bin/python"]);
		expect(commands).toEqual([]);
	});

	it("sends unrecognized slash-prefixed text as plain text", async () => {
		const { submits, commands, stdin } = mountWith("/xyz");
		await tick();

		stdin.write(CR);
		await tick();

		expect(submits).toEqual(["/xyz"]);
		expect(commands).toEqual([]);
	});
});

describe("InputBox completion arbitration", () => {
	const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
	const CR = "\r";

	type CompletionCalls = {
		readonly moves: string[];
		readonly accepted: number[];
		readonly dismissed: number[];
	};

	function mountWithCompletion(active: boolean): {
		readonly calls: CompletionCalls;
		readonly submits: string[];
		readonly changes: string[];
		readonly stdin: { write: (data: string) => void };
	} {
		const calls: CompletionCalls = { moves: [], accepted: [], dismissed: [] };
		const submits: string[] = [];
		const changes: string[] = [];
		const { stdin } = render(
			<InputBox
				value="/file no"
				onChange={(next) => changes.push(next)}
				onSubmit={(text) => submits.push(text)}
				onCommand={() => {}}
				completion={{
					active,
					moveUp: () => calls.moves.push("up"),
					moveDown: () => calls.moves.push("down"),
					accept: () => calls.accepted.push(1),
					dismiss: () => calls.dismissed.push(1),
				}}
			/>,
		);
		return { calls, submits, changes, stdin };
	}

	it("routes arrows, Enter and Esc to an active completion", async () => {
		const { calls, submits, stdin } = mountWithCompletion(true);
		await tick();

		stdin.write(`${ESC}[A`); // Up
		stdin.write(`${ESC}[B`); // Down
		stdin.write(CR);
		stdin.write(ESC);
		await tick();

		expect(calls.moves).toEqual(["up", "down"]);
		expect(calls.accepted).toEqual([1]);
		expect(calls.dismissed).toEqual([1]);
		// Enter went to the picker, not to submit.
		expect(submits).toEqual([]);
	});

	it("lets typing fall through while the completion is active", async () => {
		const { calls, changes, stdin } = mountWithCompletion(true);
		await tick();

		stdin.write("x");
		await tick();

		expect(changes).toEqual(["/file nox"]);
		expect(calls.moves).toEqual([]);
	});

	it("leaves Shift+Arrow to the chat viewport even when active", async () => {
		const { calls, stdin } = mountWithCompletion(true);
		await tick();

		stdin.write(`${ESC}[1;2A`);
		stdin.write(`${ESC}[1;2B`);
		await tick();

		expect(calls.moves).toEqual([]);
	});

	it("keeps normal Enter dispatch when the completion is inactive", async () => {
		const { calls, submits, stdin } = mountWithCompletion(false);
		await tick();

		stdin.write(CR);
		await tick();

		expect(calls.accepted).toEqual([]);
		// `/file no` is a known command, so it dispatches via onCommand — the
		// point is the picker's accept was NOT called and the input went
		// through the normal path.
		expect(submits).toEqual([]);
	});
});

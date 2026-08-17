import { describe, expect, it } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { useState } from "react";
import type { DirLister, FileCandidate } from "../../src/fileCompletion";
import { type FileCompletion, useFileCompletion } from "../../src/useFileCompletion";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
// A listing round-trip is effect → promise → setState → re-render; give the
// chain a few turns before asserting.
const settle = async () => {
	await tick();
	await tick();
	await tick();
};

const dir = (name: string): FileCandidate => ({ name, isDirectory: true });
const file = (name: string): FileCandidate => ({ name, isDirectory: false });

const CWD_ENTRIES: FileCandidate[] = [file("notes.txt"), dir("docs"), file("README.md")];
const DOCS_ENTRIES: FileCandidate[] = [file("report.md"), dir("archive")];

function listerFor(map: Record<string, FileCandidate[]>): DirLister {
	return async (d) => {
		const found = map[d];
		if (!found) throw new Error(`ENOENT: ${d}`);
		return found;
	};
}

type Snapshot = {
	readonly input: string;
	readonly fc: FileCompletion;
};

function mount(lister: DirLister, initial = "/file ") {
	let latest: Snapshot | null = null;
	let setInputExternal: (value: string) => void = () => {};
	function Probe() {
		const [input, setInput] = useState(initial);
		setInputExternal = setInput;
		const fc = useFileCompletion({ input, onChange: setInput, lister });
		latest = { input, fc };
		return <Text>{input}</Text>;
	}
	render(<Probe />);
	return {
		snap(): Snapshot {
			if (!latest) throw new Error("Probe never rendered");
			return latest;
		},
		setInput(value: string) {
			setInputExternal(value);
		},
	};
}

describe("useFileCompletion", () => {
	it("stays inactive for non-file input and never lists", async () => {
		let calls = 0;
		const counting: DirLister = async (d) => {
			calls++;
			return listerFor({ ".": CWD_ENTRIES })(d);
		};
		const app = mount(counting, "hello");
		await settle();

		expect(app.snap().fc.active).toBe(false);
		expect(calls).toBe(0);
	});

	it("activates on `/file ` and lists the cwd, directories first", async () => {
		const app = mount(listerFor({ ".": CWD_ENTRIES }));
		await settle();

		const { fc } = app.snap();
		expect(fc.active).toBe(true);
		// Directories first; files in localeCompare order (case-insensitive
		// primary collation puts "notes.txt" ahead of "README.md").
		expect(fc.candidates.map((c) => c.name)).toEqual(["docs", "notes.txt", "README.md"]);
		expect(fc.selectedIndex).toBe(0);
	});

	it("narrows synchronously as the basename is typed, without re-listing", async () => {
		let calls = 0;
		const counting: DirLister = async (d) => {
			calls++;
			return CWD_ENTRIES;
		};
		const app = mount(counting);
		await settle();

		app.setInput("/file no");
		await settle();

		const { fc } = app.snap();
		expect(fc.candidates.map((c) => c.name)).toEqual(["notes.txt"]);
		expect(calls).toBe(1);
	});

	it("clamps selection at both ends", async () => {
		const app = mount(listerFor({ ".": CWD_ENTRIES }));
		await settle();

		app.snap().fc.moveUp();
		await tick();
		expect(app.snap().fc.selectedIndex).toBe(0);

		app.snap().fc.moveDown();
		app.snap().fc.moveDown();
		app.snap().fc.moveDown();
		await tick();
		expect(app.snap().fc.selectedIndex).toBe(2);
	});

	it("accepting a directory descends and keeps the picker open", async () => {
		const app = mount(listerFor({ ".": CWD_ENTRIES, "docs/": DOCS_ENTRIES }));
		await settle();

		app.snap().fc.accept();
		await settle();

		const { input, fc } = app.snap();
		expect(input).toBe("/file docs/");
		expect(fc.active).toBe(true);
		expect(fc.candidates.map((c) => c.name)).toEqual(["archive", "report.md"]);
	});

	it("accepting a file fills the path and closes the picker", async () => {
		const app = mount(listerFor({ ".": CWD_ENTRIES }));
		await settle();

		app.snap().fc.moveDown();
		await tick();
		app.snap().fc.accept();
		await settle();

		const { input, fc } = app.snap();
		expect(input).toBe("/file notes.txt");
		expect(fc.active).toBe(false);
	});

	it("typing after a file accept reopens the picker", async () => {
		const app = mount(listerFor({ ".": CWD_ENTRIES }));
		await settle();

		app.snap().fc.moveDown();
		await tick();
		app.snap().fc.accept();
		await settle();
		expect(app.snap().fc.active).toBe(false);

		app.setInput("/file notes.tx");
		await settle();
		expect(app.snap().fc.active).toBe(true);
		expect(app.snap().fc.candidates.map((c) => c.name)).toEqual(["notes.txt"]);
	});

	it("Esc dismisses until the input changes", async () => {
		const app = mount(listerFor({ ".": CWD_ENTRIES }));
		await settle();

		app.snap().fc.dismiss();
		await settle();
		expect(app.snap().fc.active).toBe(false);

		app.setInput("/file R");
		await settle();
		expect(app.snap().fc.active).toBe(true);
	});

	it("hides when the directory is unreadable instead of crashing", async () => {
		const app = mount(listerFor({}));
		await settle();
		expect(app.snap().fc.active).toBe(false);
	});

	it("drops a listing that resolves after the directory moved on", async () => {
		let resolveSlow: (entries: FileCandidate[]) => void = () => {};
		const lister: DirLister = (d) => {
			if (d === "slow/") {
				return new Promise((resolve) => {
					resolveSlow = resolve;
				});
			}
			return Promise.resolve(DOCS_ENTRIES);
		};
		const app = mount(lister, "/file slow/");
		await tick();

		app.setInput("/file fast/");
		await settle();
		expect(app.snap().fc.candidates.map((c) => c.name)).toContain("report.md");

		// The stale listing lands late — it must not replace the current one.
		resolveSlow(CWD_ENTRIES);
		await settle();
		expect(app.snap().fc.candidates.map((c) => c.name)).toContain("report.md");
	});
});

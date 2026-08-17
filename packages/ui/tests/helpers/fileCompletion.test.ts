import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type FileCandidate,
	buildAcceptedInput,
	fileCommandArg,
	filterCandidates,
	parseFilePartial,
} from "../../src/fileCompletion";

const file = (name: string): FileCandidate => ({ name, isDirectory: false });
const dir = (name: string): FileCandidate => ({ name, isDirectory: true });

describe("fileCommandArg", () => {
	it("returns null for non-file input", () => {
		expect(fileCommandArg("hello")).toBeNull();
		expect(fileCommandArg("/connect host")).toBeNull();
		expect(fileCommandArg("/files x")).toBeNull();
	});

	it("returns null for the bare command without the separating space", () => {
		expect(fileCommandArg("/file")).toBeNull();
	});

	it("returns the argument, possibly empty, once the space is typed", () => {
		expect(fileCommandArg("/file ")).toBe("");
		expect(fileCommandArg("/file ~/Doc")).toBe("~/Doc");
	});
});

describe("parseFilePartial", () => {
	it("treats separator-free input as a basename in the cwd", () => {
		expect(parseFilePartial("foo")).toEqual({ dirPart: "", baseName: "foo", expandedDir: "." });
	});

	it("splits at the last forward slash", () => {
		expect(parseFilePartial("a/b/c")).toEqual({
			dirPart: "a/b/",
			baseName: "c",
			expandedDir: "a/b/",
		});
	});

	it("splits at a backslash too", () => {
		const partial = parseFilePartial("a\\b");
		expect(partial.dirPart).toBe("a\\");
		expect(partial.baseName).toBe("b");
	});

	it("keeps the trailing separator with an empty basename", () => {
		expect(parseFilePartial("src/")).toEqual({
			dirPart: "src/",
			baseName: "",
			expandedDir: "src/",
		});
	});

	it("expands a leading tilde in the directory part only", () => {
		// "~/Doc": the directory being listed is `~/` itself, "Doc" is the
		// basename fragment.
		expect(parseFilePartial("~/Doc").expandedDir).toBe(homedir());
		expect(parseFilePartial("~/").expandedDir).toBe(homedir());
	});

	it("expands the bare tilde directory", () => {
		expect(parseFilePartial("~/x").expandedDir.startsWith(homedir())).toBe(true);
	});
});

describe("filterCandidates", () => {
	const entries: FileCandidate[] = [
		file("zebra.txt"),
		dir("docs"),
		file("docker-compose.yml"),
		dir("downloads"),
		file(".hidden"),
	];

	it("lists everything for an empty query, directories first", () => {
		const result = filterCandidates(entries, "");
		expect(result.map((c) => c.name)).toEqual([
			"docs",
			"downloads",
			"docker-compose.yml",
			"zebra.txt",
		]);
	});

	it("hides dotfiles unless the query starts with a dot", () => {
		expect(filterCandidates(entries, "h").map((c) => c.name)).not.toContain(".hidden");
		expect(filterCandidates(entries, ".h").map((c) => c.name)).toContain(".hidden");
	});

	it("fuzzy-matches non-contiguous fragments", () => {
		const result = filterCandidates(entries, "dcmp");
		expect(result.map((c) => c.name)).toContain("docker-compose.yml");
	});

	it("hoists directories above files within the fuzzy order", () => {
		const result = filterCandidates(entries, "do");
		expect(result[0]?.isDirectory).toBe(true);
		expect(result.map((c) => c.name)).toContain("docker-compose.yml");
	});

	it("returns nothing when nothing matches", () => {
		expect(filterCandidates(entries, "qqqqq")).toEqual([]);
	});
});

describe("buildAcceptedInput", () => {
	it("appends a trailing slash for directories so completion continues", () => {
		expect(buildAcceptedInput("~/", dir("docs"))).toBe("~/docs/");
	});

	it("completes the path for files", () => {
		expect(buildAcceptedInput("~/", file("a.txt"))).toBe("~/a.txt");
	});

	it("works without a directory part", () => {
		expect(buildAcceptedInput("", file("a.txt"))).toBe("a.txt");
	});
});

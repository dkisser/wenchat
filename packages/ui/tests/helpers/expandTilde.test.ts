import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandTilde } from "../../src/expandTilde";

describe("expandTilde", () => {
	it("expands a bare tilde to the home directory", () => {
		expect(expandTilde("~")).toBe(homedir());
	});

	it("expands ~/ paths", () => {
		expect(expandTilde("~/Documents/a.pdf")).toBe(join(homedir(), "Documents/a.pdf"));
	});

	it("expands a trailing ~/ to the home directory", () => {
		expect(expandTilde("~/")).toBe(homedir());
	});

	it("expands ~\\ paths for Windows-style input", () => {
		expect(expandTilde("~\\Documents\\a.pdf")).toBe(join(homedir(), "Documents\\a.pdf"));
	});

	it("passes absolute paths through unchanged", () => {
		expect(expandTilde("/tmp/a.pdf")).toBe("/tmp/a.pdf");
	});

	it("passes relative paths through unchanged", () => {
		expect(expandTilde("docs/a.pdf")).toBe("docs/a.pdf");
	});

	it("does not expand ~user prefixes", () => {
		expect(expandTilde("~root/a.pdf")).toBe("~root/a.pdf");
	});

	it("passes an empty string through unchanged", () => {
		expect(expandTilde("")).toBe("");
	});
});

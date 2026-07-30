import { describe, expect, it } from "bun:test";
import { MAGIC_COMMANDS, matchCommands, parseCommand } from "./magicCommands";

describe("parseCommand", () => {
	it("returns null for plain text", () => {
		expect(parseCommand("hello world")).toBeNull();
	});

	it("returns null for empty input", () => {
		expect(parseCommand("")).toBeNull();
		expect(parseCommand("   ")).toBeNull();
	});

	it("returns null for a lone slash", () => {
		expect(parseCommand("/")).toBeNull();
	});

	it("parses a bare command name", () => {
		expect(parseCommand("/exit")).toEqual({ name: "exit", arg: "" });
		expect(parseCommand("/help")).toEqual({ name: "help", arg: "" });
	});

	it("parses a command with an argument", () => {
		expect(parseCommand("/file foo.txt")).toEqual({
			name: "file",
			arg: "foo.txt",
		});
	});

	it("trims whitespace around the argument", () => {
		expect(parseCommand("/connect   127.0.0.1:9001  ")).toEqual({
			name: "connect",
			arg: "127.0.0.1:9001",
		});
	});

	it("keeps the name literal even when unknown", () => {
		expect(parseCommand("/unknown")).toEqual({ name: "unknown", arg: "" });
		expect(parseCommand("/nope arg")).toEqual({ name: "nope", arg: "arg" });
	});

	it("preserves multi-word arguments", () => {
		expect(parseCommand("/file /Users/me/Some File.txt")).toEqual({
			name: "file",
			arg: "/Users/me/Some File.txt",
		});
	});
});

describe("MAGIC_COMMANDS", () => {
	it("includes exit, file, help, connect", () => {
		const names = MAGIC_COMMANDS.map((c) => c.name);
		expect(names).toContain("exit");
		expect(names).toContain("file");
		expect(names).toContain("help");
		expect(names).toContain("connect");
	});

	it("is frozen", () => {
		expect(Object.isFrozen(MAGIC_COMMANDS)).toBe(true);
	});
});

describe("matchCommands", () => {
	it("returns all commands when prefix is empty", () => {
		expect(matchCommands("").length).toBe(MAGIC_COMMANDS.length);
	});

	it("filters by prefix", () => {
		const matches = matchCommands("fi");
		expect(matches.length).toBe(1);
		expect(matches[0].name).toBe("file");
	});

	it("is case-insensitive", () => {
		expect(matchCommands("EX").map((c) => c.name)).toContain("exit");
	});

	it("returns empty array when no commands match", () => {
		expect(matchCommands("xyz")).toEqual([]);
	});
});

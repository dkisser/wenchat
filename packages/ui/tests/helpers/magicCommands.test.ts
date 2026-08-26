import { describe, expect, it } from "bun:test";
import {
	MAGIC_COMMANDS,
	isKnownCommand,
	matchCommands,
	parseCommand,
	splitCommand,
} from "../../src/magicCommands";

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
	it("includes exit, file, help, connect, disconnect", () => {
		const names = MAGIC_COMMANDS.map((c) => c.name);
		expect(names).toContain("exit");
		expect(names).toContain("file");
		expect(names).toContain("help");
		expect(names).toContain("connect");
		expect(names).toContain("disconnect");
	});

	it("includes reconnect and cancel", () => {
		const names = MAGIC_COMMANDS.map((c) => c.name);
		expect(names).toContain("reconnect");
		expect(names).toContain("cancel");
	});

	it("auto-registers reconnect/cancel in isKnownCommand", () => {
		expect(isKnownCommand("reconnect")).toBe(true);
		expect(isKnownCommand("cancel")).toBe(true);
	});

	it("matchCommands surfaces reconnect on 'rec' prefix", () => {
		expect(matchCommands("rec").map((c) => c.name)).toContain("reconnect");
	});

	it("is frozen", () => {
		expect(Object.isFrozen(MAGIC_COMMANDS)).toBe(true);
	});
});

describe("isKnownCommand", () => {
	it("returns true for every registered name", () => {
		for (const cmd of MAGIC_COMMANDS) {
			expect(isKnownCommand(cmd.name)).toBe(true);
		}
	});

	it("returns false for unknown names", () => {
		expect(isKnownCommand("xyz")).toBe(false);
		expect(isKnownCommand("filex")).toBe(false);
		expect(isKnownCommand("")).toBe(false);
	});

	it("returns false for absolute paths (the /Users/... regression)", () => {
		// Regression: paths like /Users/wenchen/workspace/yhh/claw-yhh/.venv/bin/python
		// used to be misidentified as slash commands. isKnownCommand must
		// reject the leading-slash path so InputBox falls through to onSubmit.
		expect(isKnownCommand("Users/wenchen/workspace/yhh/claw-yhh/.venv/bin/python")).toBe(false);
		expect(isKnownCommand("Users/me/Some File.txt")).toBe(false);
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

describe("splitCommand", () => {
	it("returns empty name for plain text", () => {
		expect(splitCommand("hello world")).toEqual({ name: "", arg: "hello world" });
	});

	it("returns empty name for an empty string", () => {
		expect(splitCommand("")).toEqual({ name: "", arg: "" });
	});

	it("returns empty name for a lone slash", () => {
		expect(splitCommand("/")).toEqual({ name: "/", arg: "" });
	});

	it("splits a bare command name", () => {
		expect(splitCommand("/help")).toEqual({ name: "/help", arg: "" });
	});

	it("splits a command with an argument", () => {
		expect(splitCommand("/file /etc/hosts")).toEqual({ name: "/file", arg: "/etc/hosts" });
	});

	it("preserves trailing whitespace in the argument", () => {
		expect(splitCommand("/file   foo  ")).toEqual({ name: "/file", arg: "  foo  " });
	});

	it("includes unknown command names verbatim", () => {
		expect(splitCommand("/nope arg")).toEqual({ name: "/nope", arg: "arg" });
	});
});

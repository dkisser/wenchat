import { describe, expect, it } from "bun:test";
import { hostname } from "node:os";
import { type CliAction, parseCliArgs } from "../src/parseArgs";

function assertStart(action: CliAction): asserts action is Extract<CliAction, { kind: "start" }> {
	expect(action.kind).toBe("start");
}

describe("parseCliArgs", () => {
	describe("operational subcommands", () => {
		it("returns version for 'version'", () => {
			expect(parseCliArgs(["version"])).toEqual({ kind: "version" });
		});

		it("returns version for '--version'", () => {
			expect(parseCliArgs(["--version"])).toEqual({ kind: "version" });
		});

		it("returns version for '-v'", () => {
			expect(parseCliArgs(["-v"])).toEqual({ kind: "version" });
		});

		it("returns help for 'help'", () => {
			expect(parseCliArgs(["help"])).toEqual({ kind: "help" });
		});

		it("returns help for '--help'", () => {
			expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
		});

		it("returns help for '-h'", () => {
			expect(parseCliArgs(["-h"])).toEqual({ kind: "help" });
		});

		it("returns upgrade without check-only", () => {
			expect(parseCliArgs(["upgrade"])).toEqual({ kind: "upgrade", checkOnly: false });
		});

		it("returns upgrade with --check-only", () => {
			expect(parseCliArgs(["upgrade", "--check-only"])).toEqual({
				kind: "upgrade",
				checkOnly: true,
			});
		});

		it("treats 'update' as an alias for upgrade", () => {
			expect(parseCliArgs(["update", "--check-only"])).toEqual({
				kind: "upgrade",
				checkOnly: true,
			});
		});

		it("returns help when no arguments are given", () => {
			expect(parseCliArgs([])).toEqual({ kind: "help" });
		});
	});

	describe("start subcommand positional form", () => {
		it("starts with hostname default when no args are given", () => {
			const action = parseCliArgs(["start"]);
			assertStart(action);
			expect(action.displayName).toBe(hostname() || "user");
			expect(action.signalingPort).toBe(0);
			expect(action.signalingHost).toBeUndefined();
			expect(action.mouseEnabled).toBe(true);
		});

		it("sets display name from first positional", () => {
			const action = parseCliArgs(["start", "alice"]);
			assertStart(action);
			expect(action.displayName).toBe("alice");
			expect(action.signalingPort).toBe(0);
			expect(action.signalingHost).toBeUndefined();
		});

		it("sets display name and port from positionals", () => {
			const action = parseCliArgs(["start", "alice", "9000"]);
			assertStart(action);
			expect(action.displayName).toBe("alice");
			expect(action.signalingPort).toBe(9000);
			expect(action.signalingHost).toBeUndefined();
		});

		it("sets all three start positionals", () => {
			const action = parseCliArgs(["start", "alice", "9000", "192.168.1.100"]);
			assertStart(action);
			expect(action.displayName).toBe("alice");
			expect(action.signalingPort).toBe(9000);
			expect(action.signalingHost).toBe("192.168.1.100");
		});

		it("ignores extra positionals beyond three", () => {
			const action = parseCliArgs(["start", "alice", "9000", "192.168.1.100", "extra"]);
			assertStart(action);
			expect(action.displayName).toBe("alice");
			expect(action.signalingPort).toBe(9000);
			expect(action.signalingHost).toBe("192.168.1.100");
		});
	});

	describe("start subcommand flag form", () => {
		it("parses --name", () => {
			const action = parseCliArgs(["start", "--name", "alice"]);
			assertStart(action);
			expect(action.displayName).toBe("alice");
			expect(action.signalingPort).toBe(0);
			expect(action.signalingHost).toBeUndefined();
		});

		it("parses -n short flag", () => {
			const action = parseCliArgs(["start", "-n", "alice"]);
			assertStart(action);
			expect(action.displayName).toBe("alice");
		});

		it("parses --port", () => {
			const action = parseCliArgs(["start", "--port", "9000"]);
			assertStart(action);
			expect(action.signalingPort).toBe(9000);
		});

		it("parses -p short flag", () => {
			const action = parseCliArgs(["start", "-p", "9000"]);
			assertStart(action);
			expect(action.signalingPort).toBe(9000);
		});

		it("parses --host", () => {
			const action = parseCliArgs(["start", "--host", "192.168.1.100"]);
			assertStart(action);
			expect(action.signalingHost).toBe("192.168.1.100");
		});

		it("parses all start flags together", () => {
			const action = parseCliArgs([
				"start",
				"--name",
				"alice",
				"--port",
				"9000",
				"--host",
				"192.168.1.100",
			]);
			assertStart(action);
			expect(action.displayName).toBe("alice");
			expect(action.signalingPort).toBe(9000);
			expect(action.signalingHost).toBe("192.168.1.100");
		});

		it("parses short flags together", () => {
			const action = parseCliArgs(["start", "-n", "alice", "-p", "9000"]);
			assertStart(action);
			expect(action.displayName).toBe("alice");
			expect(action.signalingPort).toBe(9000);
		});

		it("disables mouse with --no-mouse", () => {
			const action = parseCliArgs(["start", "--no-mouse"]);
			assertStart(action);
			expect(action.mouseEnabled).toBe(false);
		});

		it("defaults mouse to enabled", () => {
			const action = parseCliArgs(["start"]);
			assertStart(action);
			expect(action.mouseEnabled).toBe(true);
		});
	});

	describe("start subcommand boolean flag with positionals", () => {
		it("allows --no-mouse after positionals", () => {
			const action = parseCliArgs(["start", "alice", "9000", "--no-mouse"]);
			assertStart(action);
			expect(action.displayName).toBe("alice");
			expect(action.signalingPort).toBe(9000);
			expect(action.mouseEnabled).toBe(false);
		});

		it("allows --no-mouse before positionals", () => {
			const action = parseCliArgs(["start", "--no-mouse", "alice", "9000"]);
			assertStart(action);
			expect(action.displayName).toBe("alice");
			expect(action.signalingPort).toBe(9000);
			expect(action.mouseEnabled).toBe(false);
		});
	});

	describe("error cases", () => {
		it("throws for unknown subcommand", () => {
			expect(() => parseCliArgs(["paul", "9000"])).toThrow(/Unknown subcommand/);
		});

		it("throws for bare nickname without start", () => {
			expect(() => parseCliArgs(["alice"])).toThrow(/Unknown subcommand/);
		});

		it("throws when value flags are mixed with positionals", () => {
			expect(() => parseCliArgs(["start", "--name", "alice", "bob"])).toThrow(
				/Cannot combine --name|--port|--host with positional arguments/,
			);
		});

		it("throws when --port is mixed with positionals", () => {
			expect(() => parseCliArgs(["start", "--port", "9000", "alice"])).toThrow(
				/Cannot combine --name|--port|--host with positional arguments/,
			);
		});

		it("throws when --host is mixed with positionals", () => {
			expect(() => parseCliArgs(["start", "--host", "10.0.0.1", "alice"])).toThrow(
				/Cannot combine --name|--port|--host with positional arguments/,
			);
		});

		it("throws when --name is missing its value", () => {
			expect(() => parseCliArgs(["start", "--name"])).toThrow(/--name requires/);
		});

		it("throws when --port is not a number", () => {
			expect(() => parseCliArgs(["start", "--port", "abc"])).toThrow(/valid port/);
		});

		it("throws when --port is out of range", () => {
			expect(() => parseCliArgs(["start", "--port", "70000"])).toThrow(/valid port/);
		});

		it("throws for unknown flag on start", () => {
			expect(() => parseCliArgs(["start", "--unknown"])).toThrow(/Unknown option/);
		});

		it("throws when flags are passed without start", () => {
			expect(() => parseCliArgs(["--no-mouse"])).toThrow(/Unknown subcommand/);
		});
	});
});

import { describe, expect, it } from "bun:test";
import { hostname } from "node:os";
import { resolveDisplayName } from "../src/displayName";

describe("resolveDisplayName", () => {
	it("returns the explicit positional arg when given", () => {
		// The user passed `cli alice` — preserve whatever they typed, do not
		// fall through to the hostname. Anything else would silently rename
		// a nickname the user picked on purpose.
		expect(resolveDisplayName(["alice"])).toBe("alice");
	});

	it("falls back to os.hostname() when no positional arg is given", () => {
		// When the user runs `wenchat` with no name, the peer list on the
		// other side used to show `user-1234` (random) — useless when more
		// than one wenchat is on the LAN. The hostname at least names the
		// machine, even if two with the same hostname look identical.
		expect(resolveDisplayName([])).toBe(hostname());
	});
});

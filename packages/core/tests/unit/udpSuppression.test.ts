import { afterEach, describe, expect, it } from "bun:test";
import dgram from "node:dgram";
import { suppressUdpRefused } from "../helpers/udpSuppression";

// Helper-level tests: pin the suppression contract so future werift / STUN
// tests can rely on it without having to re-derive the patch.

describe("suppressUdpRefused", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	function install(): () => void {
		const restore = suppressUdpRefused();
		cleanups.push(restore);
		return restore;
	}

	it("swallows ECONNREFUSED on dgram.Socket error events", () => {
		install();
		const sock = dgram.createSocket("udp4");
		let fired = false;
		sock.on("error", () => {
			fired = true;
		});

		const result = sock.emit(
			"error",
			Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
		);

		// The patched emit short-circuits the error event and returns false
		// as if no listener were attached — that's what stops
		// EventEmitter from throwing it as an uncaughtException.
		expect(result).toBe(false);
		expect(fired).toBe(false);
		sock.close();
	});

	it("swallows EHOSTUNREACH on dgram.Socket error events", () => {
		install();
		const sock = dgram.createSocket("udp4");
		let fired = false;
		sock.on("error", () => {
			fired = true;
		});

		const result = sock.emit(
			"error",
			Object.assign(new Error("unreachable"), { code: "EHOSTUNREACH" }),
		);

		expect(result).toBe(false);
		expect(fired).toBe(false);
		sock.close();
	});

	it("lets unrelated error codes propagate to listeners", () => {
		install();
		const sock = dgram.createSocket("udp4");
		let firedWith: unknown = null;
		sock.on("error", (err: unknown) => {
			firedWith = err;
		});

		const result = sock.emit("error", Object.assign(new Error("permission"), { code: "EACCES" }));

		expect(result).toBe(true);
		expect(firedWith).not.toBeNull();
		expect((firedWith as { code?: string }).code).toBe("EACCES");
		sock.close();
	});

	it("passes non-error events through to listeners unchanged", () => {
		install();
		const sock = dgram.createSocket("udp4");
		let listening = false;
		sock.on("listening", () => {
			listening = true;
		});

		const result = sock.emit("listening");

		expect(result).toBe(true);
		expect(listening).toBe(true);
		sock.close();
	});

	it("restore() reverts the prototype patch", () => {
		const restore = install();
		const sock = dgram.createSocket("udp4");
		let fired = false;
		sock.on("error", () => {
			fired = true;
		});

		// While installed: suppressed.
		sock.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
		expect(fired).toBe(false);

		// After restore: normal EventEmitter behavior — the listener fires.
		restore();
		const result = sock.emit(
			"error",
			Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
		);
		expect(result).toBe(true);
		expect(fired).toBe(true);
		sock.close();
	});

	it("a second install() is a no-op until restore() is called", () => {
		const firstRestore = install();
		const secondRestore = suppressUdpRefused();
		// Second restore is a no-op — restoring once is enough to undo
		// the patch.
		secondRestore();

		const sock = dgram.createSocket("udp4");
		let fired = false;
		sock.on("error", () => {
			fired = true;
		});
		sock.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
		expect(fired).toBe(false);

		firstRestore();
		// After the real restore, the patch is gone.
		sock.removeAllListeners("error");
		sock.on("error", () => {
			fired = true;
		});
		sock.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
		expect(fired).toBe(true);
		sock.close();
	});
});

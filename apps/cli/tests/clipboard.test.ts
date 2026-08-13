import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { copyToClipboard } from "../src/clipboard";

type FakeChild = EventEmitter & {
	stdin: EventEmitter & { end: (text: string) => void; write: (text: string) => boolean };
	stdout: EventEmitter;
	stderr: EventEmitter;
	exit: (code: number | null) => void;
	errorWith: (err: Error) => void;
};

function makeChild(): FakeChild {
	const stdin = new EventEmitter() as EventEmitter & {
		end: (text: string) => void;
		write: (text: string) => boolean;
	};
	stdin.end = (text: string) => {
		stdin.write(text);
		stdin.emit("finish");
	};
	stdin.write = () => true;
	const child = new EventEmitter() as FakeChild;
	child.stdin = stdin;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.exit = (code) => child.emit("exit", code);
	// Defer so listeners inside the runHelper promise are already registered
	// when the event fires.
	child.errorWith = (err) => queueMicrotask(() => child.emit("error", err));
	return child;
}

/**
 * Build a fake `spawn` from a per-command child map. A missing entry throws
 * synchronously — equivalent to ENOENT in real spawn, and lets each test
 * pick which helpers exist on the "system" without a stub.
 */
function buildSpawn(
	byCommand: Partial<Record<"pbcopy" | "clip" | "wl-copy" | "xclip" | "xsel", FakeChild>>,
): (cmd: string, args: readonly string[], options: unknown) => FakeChild {
	return (cmd: string, _args: readonly string[], _options: unknown) => {
		const child = byCommand[cmd as keyof typeof byCommand];
		if (!child) {
			// Synchronous ENOENT — mirrors the real spawn behaviour when a
			// clipboard helper binary isn't on $PATH. copyToClipboard's
			// outer try/catch turns this into a fall-through.
			throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT" });
		}
		return child;
	};
}

describe("copyToClipboard", () => {
	let writes: string[];
	let originalWrite: typeof process.stdout.write;

	beforeEach(() => {
		writes = [];
		originalWrite = process.stdout.write.bind(process.stdout);
		(process.stdout as unknown as { write: (chunk: string) => boolean }).write = (
			chunk: string,
		) => {
			writes.push(String(chunk));
			return true;
		};
	});

	afterEach(() => {
		(process.stdout as unknown as { write: typeof process.stdout.write }).write = originalWrite;
	});

	it("invokes pbcopy on macOS and writes the text to its stdin", async () => {
		const pbcopy = makeChild();
		let receivedText: string | null = null;
		pbcopy.stdin.write = (text: string) => {
			receivedText = text;
			return true;
		};

		const promise = copyToClipboard("hello world", {
			platform: "darwin",
			spawn: buildSpawn({ pbcopy }),
			stdoutIsTTY: false,
		});
		pbcopy.exit(0);
		const result = await promise;

		expect(result).toEqual({ ok: true, method: "pbcopy" });
		expect(receivedText).toBe("hello world");
	});

	it("passes -selection clipboard to xclip when wl-copy is absent on linux", async () => {
		const xclip = makeChild();
		let receivedArgs: string[] = [];
		const originalWrite = xclip.stdin.write;
		xclip.stdin.write = ((text: string) => {
			receivedArgs = [text];
			return originalWrite(text);
		}) as typeof xclip.stdin.write;

		const promise = copyToClipboard("data", {
			platform: "linux",
			// wl-copy absent → first probe throws ENOENT → fall through to xclip.
			spawn: buildSpawn({ xclip }),
			stdoutIsTTY: false,
		});
		xclip.exit(0);
		const result = await promise;

		expect(result).toEqual({ ok: true, method: "xclip" });
	});

	it("forwards -selection clipboard args to xclip", async () => {
		const xclip = makeChild();
		let receivedArgs: string[] = [];
		// Wrap buildSpawn so we can observe what args xclip actually got.
		const spawnFn = ((cmd: string, args: readonly string[], options: unknown) => {
			if (cmd === "xclip") receivedArgs = [cmd, ...args];
			return buildSpawn({ xclip })(cmd, args, options);
		}) as (cmd: string, args: readonly string[], options: unknown) => FakeChild;

		const promise = copyToClipboard("data", {
			platform: "linux",
			spawn: spawnFn,
			stdoutIsTTY: false,
		});
		xclip.exit(0);
		await promise;

		expect(receivedArgs).toEqual(["xclip", "-selection", "clipboard"]);
	});

	it("passes -n (no-notify) to wl-copy when it exists on linux", async () => {
		const wlCopy = makeChild();
		let receivedArgs: string[] = [];
		const spawnFn = (cmd: string, args: readonly string[], _options: unknown) => {
			receivedArgs = [cmd, ...args];
			return wlCopy;
		};

		const promise = copyToClipboard("data", {
			platform: "linux",
			spawn: spawnFn,
			stdoutIsTTY: false,
		});
		wlCopy.exit(0);
		const result = await promise;

		expect(result).toEqual({ ok: true, method: "wl-copy" });
		expect(receivedArgs).toEqual(["wl-copy", "-n"]);
	});

	it("falls through ENOENT from wl-copy to xclip", async () => {
		const xclip = makeChild();
		let receivedText: string | null = null;
		xclip.stdin.write = (text: string) => {
			receivedText = text;
			return true;
		};

		const promise = copyToClipboard("payload", {
			platform: "linux",
			// wl-copy omitted from the map → spawn throws ENOENT synchronously
			spawn: buildSpawn({ xclip }),
			stdoutIsTTY: false,
		});
		xclip.exit(0);
		const result = await promise;

		expect(result).toEqual({ ok: true, method: "xclip" });
		expect(receivedText).toBe("payload");
	});

	it("writes OSC 52 to stdout when no helper is available but stdout is a TTY", async () => {
		const result = await copyToClipboard("hi", {
			platform: "linux",
			spawn: buildSpawn({}), // every helper ENOENT
			stdoutIsTTY: true,
		});

		expect(result).toEqual({ ok: true, method: "osc52" });
		expect(writes.length).toBe(1);
		// base64("hi") = "aGk="
		expect(writes[0]).toBe("]52;c;aGk=");
	});

	it("returns ok=false when no helper is available and stdout is not a TTY", async () => {
		const result = await copyToClipboard("hi", {
			platform: "linux",
			spawn: buildSpawn({}),
			stdoutIsTTY: false,
		});

		expect(result.ok).toBe(false);
		if (result.ok === false) {
			expect(result.method).toBe("none");
			expect(result.reason).toContain("TTY");
		}
		expect(writes.length).toBe(0);
	});

	it("splits OSC 52 writes when the base64 payload exceeds the chunk size", async () => {
		// 100 KB of "A" → 136 533 base64 chars → at least two chunks.
		const big = "A".repeat(100_000);
		const result = await copyToClipboard(big, {
			platform: "linux",
			spawn: buildSpawn({}),
			stdoutIsTTY: true,
		});

		expect(result).toEqual({ ok: true, method: "osc52" });
		expect(writes.length).toBeGreaterThan(1);
		for (const write of writes) {
			expect(write).toStartWith("]52;c;");
			expect(write).toEndWith("");
		}
	});

	it("reports a non-ENOENT helper failure", async () => {
		const pbcopy = makeChild();
		pbcopy.errorWith(new Error("permission denied"));
		const result = await copyToClipboard("x", {
			platform: "darwin",
			spawn: buildSpawn({ pbcopy }),
			stdoutIsTTY: false,
		});

		expect(result.ok).toBe(false);
		if (result.ok === false) {
			expect(result.reason).toContain("permission denied");
		}
	});
});

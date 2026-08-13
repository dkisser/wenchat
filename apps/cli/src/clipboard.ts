import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import process from "node:process";

/**
 * Result of a copy attempt. `method` names which path actually delivered the
 * bytes; `osc52` means we wrote the escape directly to stdout (the host
 * terminal is responsible for translating it into a clipboard write).
 */
export type CopyResult =
	| {
			readonly ok: true;
			readonly method: "pbcopy" | "xclip" | "wl-copy" | "xsel" | "clip" | "osc52";
	  }
	| {
			readonly ok: false;
			readonly method: "none";
			readonly reason: string;
	  };

/**
 * Conservative per-write chunk for OSC 52 base64. Some terminals cap the
 * payload at 100 KB to keep escape parsing linear; smaller chunks are always
 * safe and the chunking overhead is negligible.
 */
const OSC52_MAX_CHUNK = 100_000;

export type SpawnFn = (cmd: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export type CopyToClipboardDeps = {
	/** Override for tests. Defaults to `child_process.spawn`. */
	readonly spawn?: SpawnFn;
	/** Override for tests. Defaults to `process.platform`. */
	readonly platform?: NodeJS.Platform;
	/** Override for tests. Defaults to `process.stdout.isTTY`. */
	readonly stdoutIsTTY?: boolean;
	/** Override for tests. Defaults to `process.stdout.write`. */
	readonly writeStdout?: (chunk: string) => void;
};

/**
 * Copy `text` to the system clipboard.
 *
 * Resolution order:
 *   1. Native helper (`pbcopy` on macOS, `clip.exe` on Windows, then
 *      `wl-copy` / `xclip` / `xsel` on Linux/BSD). Probed in order; first
 *      one whose spawn doesn't ENOENT wins.
 *   2. ANSI OSC 52 written via `process.stdout.write`. Works in iTerm2,
 *      WezTerm, kitty, Alacritty, recent gnome-terminal, and foot. Requires
 *      `process.stdout.isTTY` — without a host terminal there is no one to
 *      receive the escape. iTerm2 also needs "Allow clipboard read/write
 *      from shell" in its advanced preferences.
 *   3. Otherwise: `{ok: false, reason: ...}`. Surfaces to the user via the
 *      system-message channel in App.tsx.
 *
 * The OSC 52 write deliberately bypasses Ink (`process.stdout.write` instead
 * of `<Text>` or `useStdout`) so the escape reaches the host terminal before
 * Ink's next render flush clobbers it. This is the same pattern used by
 * `mouseMode.ts` to emit `?1006h` on startup.
 */
export async function copyToClipboard(
	text: string,
	deps: CopyToClipboardDeps = {},
): Promise<CopyResult> {
	const spawnFn: SpawnFn = deps.spawn ?? ((cmd, args, options) => spawn(cmd, [...args], options));
	const platform = deps.platform ?? process.platform;
	const stdoutIsTTY = deps.stdoutIsTTY ?? process.stdout.isTTY === true;
	const writeStdout = deps.writeStdout ?? ((chunk: string) => process.stdout.write(chunk));

	for (const helper of helpersFor(platform)) {
		// wl-copy's `-n` suppresses a desktop toast; xclip defaults to the
		// primary selection unless we ask for the clipboard explicitly.
		const args: string[] =
			helper === "xclip" ? ["-selection", "clipboard"] : helper === "wl-copy" ? ["-n"] : [];
		let child: ChildProcess;
		try {
			// Real `child_process.spawn` throws synchronously on ENOENT
			// (the helper binary isn't installed). Wrap the call so the
			// catch below can fall through to the next helper instead of
			// crashing the whole copyToClipboard promise.
			child = spawnFn(helper, args, { stdio: ["pipe", "ignore", "ignore"] });
		} catch (err) {
			if (isEnoent(err)) continue; // helper absent — try the next
			return { ok: false, method: "none", reason: errorMessage(err) };
		}
		try {
			await runHelper(child, helper, text);
			return { ok: true, method: helper };
		} catch (err) {
			if (isEnoent(err)) continue; // helper vanished mid-flight — try the next
			return { ok: false, method: "none", reason: errorMessage(err) };
		}
	}

	if (stdoutIsTTY) {
		writeOsc52(text, writeStdout);
		return { ok: true, method: "osc52" };
	}
	return {
		ok: false,
		method: "none",
		reason: "No clipboard helper available and stdout is not a TTY",
	};
}

function helpersFor(
	platform: NodeJS.Platform,
): Array<"pbcopy" | "clip" | "wl-copy" | "xclip" | "xsel"> {
	if (platform === "darwin") return ["pbcopy"];
	if (platform === "win32") return ["clip"];
	// Linux / WSL / BSD: prefer Wayland first (most-modern sessions),
	// then X11 helpers.
	return ["wl-copy", "xclip", "xsel"];
}

function runHelper(
	child: ChildProcess,
	cmd: "pbcopy" | "clip" | "wl-copy" | "xclip" | "xsel",
	text: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const settleOnce = (fn: () => void) => {
			if (settled) return;
			settled = true;
			fn();
		};
		child.once("error", (e) => settleOnce(() => reject(e)));
		child.once("exit", (code) => {
			settleOnce(() =>
				code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code ?? "null"}`)),
			);
		});
		child.stdin?.once("error", (e) => settleOnce(() => reject(e)));
		child.stdin?.end(text);
	});
}

function writeOsc52(text: string, writeStdout: (chunk: string) => void): void {
	const encoded = Buffer.from(text, "utf8").toString("base64");
	for (let i = 0; i < encoded.length; i += OSC52_MAX_CHUNK) {
		const chunk = encoded.slice(i, i + OSC52_MAX_CHUNK);
		writeStdout(`]52;c;${chunk}`);
	}
}

function isEnoent(err: unknown): boolean {
	return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : "Unknown error";
}

#!/usr/bin/env node
// Note: `displayName` (the first positional arg) is purely an application-layer
// peer nickname that is broadcast via mDNS TXT records. It is NOT a system
// hostname and will not modify /etc/hostname, scutil settings, or any OS-level
// name. If you do see a "name changed" warning or your `scutil --get
// LocalHostName` is being rewritten with a suffix like `-1`, `-2`, … that is
// macOS `mDNSResponder` doing RFC 6762 §8.1 conflict resolution combined with
// the "Computer Name Follows Hostname" system setting. The Bonjour instance
// name we publish is `<displayName>-<6-hex of localId>`, and the localId is
// persisted to `~/.wenchat/local-id` (see `packages/core/src/discovery.ts`) so
// it stays stable across CLI runs. As long as you keep using the same nickname
// and the localId file is intact, the instance name stays stable and
// mDNSResponder has nothing to rename.
import { getLanHost, initLogger } from "@wenchat/core";
import { render } from "ink";
import { App } from "./App";
import { enterAltScreen, exitAltScreen } from "./altScreen";
import { enterMouseMode, exitMouseMode } from "./mouseMode";
import { type CliAction, parseCliArgs } from "./parseArgs";
import { installTerminalSafetyNet } from "./terminalSafetyNet";
import { HELP_TEXT, getCurrentVersion, upgradeCli } from "./updater";

// Subcommand dispatch. MUST run before any TUI / safety-net setup so that
// `wenchat version`, `wenchat upgrade`, and `wenchat help` never touch the
// terminal (no alt screen, no mouse mode, no React mount).
const rawArgs = process.argv.slice(2);

let action: CliAction;
try {
	action = parseCliArgs(rawArgs);
} catch (err: unknown) {
	const msg = err instanceof Error ? err.message : String(err);
	process.stderr.write(`wenchat: ${msg}\n`);
	process.exit(1);
}

if (action.kind === "version") {
	process.stdout.write(`wenchat ${getCurrentVersion()}\n`);
	process.exit(0);
}
if (action.kind === "help") {
	process.stdout.write(HELP_TEXT);
	process.exit(0);
}
if (action.kind === "upgrade") {
	// Top-level await (ES2022) suspends the module so we never fall through
	// into the TUI mount below. process.exit terminates before any React tree
	// could materialize. Biome rejects top-level `return`, hence this shape.
	try {
		const code = await upgradeCli({ checkOnly: action.checkOnly });
		process.exit(code);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`upgrade failed: ${msg}\n`);
		process.exit(1);
	}
}

const { displayName, signalingPort, signalingHost: explicitHost, mouseEnabled } = action;
// arg[2] is the bind host. Given explicitly (e.g. on a multi-homed host) it
// wins outright and the app boots straight into the peer list, exactly as
// before. Left out, an interactive run gets the startup picker — `undefined`
// is the signal App reads — while a piped/redirected run keeps the old
// silent default, since there is nobody there to answer a prompt.
const isInteractive = process.stdout.isTTY === true && process.stdin.isTTY === true;
const signalingHost: string | undefined = explicitHost
	? explicitHost
	: isInteractive
		? undefined
		: getLanHost();

// File logging starts here — after the subcommand dispatch above so
// `version` / `help` / `upgrade` never create `~/.wenchat/logs`.
const logger = await initLogger();
logger.info({ pid: process.pid, argv: rawArgs }, "startup");

// Enter the alternate screen buffer BEFORE Ink mounts so the user sees a
// clean fullscreen surface, not the moment of "scrollback → TUI" transition.
// Skip on non-TTY (e.g. piped output, CI logs) so `bun run cli > out.log`
// keeps producing plain text without escape sequences.
const releases = mouseEnabled ? [exitMouseMode, exitAltScreen] : [exitAltScreen];
installTerminalSafetyNet(releases);
enterAltScreen();
if (mouseEnabled) enterMouseMode();

const instance = render(
	<App displayName={displayName} signalingPort={signalingPort} signalingHost={signalingHost} />,
	// Ink's built-in Ctrl+C handler is disabled so SIGINT flows through
	// the terminal safety net instead of unmounting the React tree without
	// releasing the alternate buffer.
	{ exitOnCtrlC: false },
);

// Wait for Ink's React tree to fully unmount, then release the alternate
// buffer and exit. Waiting (instead of `setImmediate(process.exit(0))`)
// avoids racing Ink's last frame against stdout flush — the previous
// implementation could leave a partial InputBox rendered on the host screen.
instance.waitUntilExit().then(() => {
	if (mouseEnabled) exitMouseMode();
	exitAltScreen();
	process.exit(0);
});

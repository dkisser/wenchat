#!/usr/bin/env node
// Note: `displayName` (the first positional arg) is purely an application-layer
// peer nickname that is broadcast via mDNS TXT records. It is NOT a system
// hostname and will not modify /etc/hostname, scutil settings, or any OS-level
// name. If your shell or System Settings shows a "name changed" warning after
// running wenchat, that is almost certainly macOS mDNSResponder reflecting the
// Bonjour service instance name back into Sharing/Network views — not a real
// hostname mutation caused by this code.
import { getLanHost } from "@wenchat/core";
import { render } from "ink";
import { App } from "./App";
import { enterAltScreen, exitAltScreen } from "./altScreen";
import { enterMouseMode, exitMouseMode } from "./mouseMode";
import { installTerminalSafetyNet } from "./terminalSafetyNet";

// Filter --no-mouse (and any future flags) out of argv before the positional
// parsing, so `args[0..2]` retain their current shape.
const rawArgs = process.argv.slice(2);
const flags = new Set<string>();
const positional: string[] = [];
for (const arg of rawArgs) {
	if (arg.startsWith("--")) flags.add(arg);
	else positional.push(arg);
}
const mouseEnabled = !flags.has("--no-mouse");

const displayName = positional[0] || `user-${Math.floor(Math.random() * 10000)}`;
const signalingPort = Number(positional[1]) || 0;
// arg[2] is the bind host. Given explicitly (e.g. on a multi-homed host) it
// wins outright and the app boots straight into the peer list, exactly as
// before. Left out, an interactive run gets the startup picker — `undefined`
// is the signal App reads — while a piped/redirected run keeps the old
// silent default, since there is nobody there to answer a prompt.
const explicitHost = positional[2];
const isInteractive = process.stdout.isTTY === true && process.stdin.isTTY === true;
const signalingHost: string | undefined = explicitHost
	? explicitHost
	: isInteractive
		? undefined
		: getLanHost();

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

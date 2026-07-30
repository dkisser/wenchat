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
import { enterAltScreen, exitAltScreen, installAltScreenSafetyNet } from "./altScreen";

const args = process.argv.slice(2);
const displayName = args[0] || `user-${Math.floor(Math.random() * 10000)}`;
const signalingPort = Number(args[1]) || 0;
// arg[2] lets the user override (e.g. on a multi-homed host); default to the
// detected LAN IPv4 so peers on the same network can actually reach us
// instead of hitting 127.0.0.1.
const signalingHost = args[2] || getLanHost();

// Enter the alternate screen buffer BEFORE Ink mounts so the user sees a
// clean fullscreen surface, not the moment of "scrollback → TUI" transition.
// Skip on non-TTY (e.g. piped output, CI logs) so `bun run cli > out.log`
// keeps producing plain text without escape sequences.
installAltScreenSafetyNet();
enterAltScreen();

const instance = render(
	<App displayName={displayName} signalingPort={signalingPort} signalingHost={signalingHost} />,
	// Ink's built-in Ctrl+C handler is disabled so SIGINT flows through
	// installAltScreenSafetyNet() instead of unmounting the React tree
	// without releasing the alternate buffer.
	{ exitOnCtrlC: false },
);

// Wait for Ink's React tree to fully unmount, then release the alternate
// buffer and exit. Waiting (instead of `setImmediate(process.exit(0))`)
// avoids racing Ink's last frame against stdout flush — the previous
// implementation could leave a partial InputBox rendered on the host screen.
instance.waitUntilExit().then(() => {
	exitAltScreen();
	process.exit(0);
});

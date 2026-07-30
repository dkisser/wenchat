#!/usr/bin/env node
import { getLanHost } from "@wenchat/core";
import { render } from "ink";
import { App } from "./App";

const args = process.argv.slice(2);
const displayName = args[0] || `user-${Math.floor(Math.random() * 10000)}`;
const signalingPort = Number(args[1]) || 0;
// arg[2] lets the user override (e.g. on a multi-homed host); default to the
// detected LAN IPv4 so peers on the same network can actually reach us
// instead of hitting 127.0.0.1.
const signalingHost = args[2] || getLanHost();

render(
	<App displayName={displayName} signalingPort={signalingPort} signalingHost={signalingHost} />,
);

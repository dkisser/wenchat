#!/usr/bin/env node
import { render } from "ink";
import React from "react";
import { App } from "./App.tsx";

const args = process.argv.slice(2);
const displayName = args[0] || `user-${Math.floor(Math.random() * 10000)}`;
const signalingPort = Number(args[1]) || 0;

render(<App displayName={displayName} signalingPort={signalingPort} />);

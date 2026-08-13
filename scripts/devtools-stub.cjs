// scripts/devtools-stub.cjs
//
// Empty stub for `react-devtools-core`. ink conditionally imports it
// (gated by process.env.DEV === "true") and calls only connectToDevTools();
// we don't ship the devtools bridge in the packed binary, so this file
// provides the surface ink touches with no-op implementations. esbuild's
// `alias` rewrites `import ... from "react-devtools-core"` to point here.
"use strict";

module.exports = {
	connectToDevTools() {},
	initialize() {},
	send() {},
	sendToBackend() {},
	// react-devtools-core has a larger surface; anything we forgot to stub
	// will throw at runtime, surfacing the missing method rather than
	// silently swallowing the call.
};

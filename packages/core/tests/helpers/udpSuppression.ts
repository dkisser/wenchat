import dgram from "node:dgram";

// tests/helpers/udpSuppression.ts
//
// Why this exists:
//   bun:test installs its own `uncaughtException` handler during runner
//   bootstrap, BEFORE any test code runs. `process.on('uncaughtException', …)`
//   and `process.prependListener('uncaughtException', …)` therefore attach
//   AFTER bun:test's handler, so the runner's handler always fires first and
//   converts EventEmitter `'error'` events into test failures before user
//   code can suppress them.
//
//   `process.setUncaughtExceptionCaptureCallback` looks like the official
//   knob but bun-types does not declare it; behaviour is undefined under
//   bun:test.
//
// The fix:
//   Monkey-patch `dgram.Socket.prototype.emit` to short-circuit the `error`
//   event when `err.code` is in the port-unreachable family
//   (`ECONNREFUSED` / `EHOSTUNREACH`). Returning `false` as if no listener
//   were attached stops EventEmitter from throwing the error as an
//   uncaughtException. macOS silently drops the ICMP for closed UDP ports,
//   so this suppression is only necessary on Linux CI.
//
// Usage:
//   const restore = suppressUdpRefused();
//   try {
//     … test code that exercises werift / STUN / UDP teardown …
//   } finally {
//     restore();
//   }
//
// The patch is idempotent — a second call without an intervening
// `restore()` is a no-op and returns an inert cleanup. This keeps nested
// test scopes (`describe` inside `describe`) safe.

const SUPPRESS_MARKER = Symbol.for("wenchat.peer-test.udp-suppressed");

interface PatchableSocketPrototype {
	emit: (event: string, ...args: unknown[]) => boolean;
}

export const suppressUdpRefused = (): (() => void) => {
	const proto = dgram.Socket.prototype as unknown as PatchableSocketPrototype & {
		[k: symbol]: boolean;
	};
	if (proto[SUPPRESS_MARKER]) {
		// Already installed; surface a no-op restore so try/finally stays
		// symmetric for callers.
		return () => {};
	}

	const originalEmit = proto.emit;
	proto.emit = function patchedEmit(event: string, ...args: unknown[]): boolean {
		if (event === "error") {
			const err = args[0] as { code?: string } | null | undefined;
			const code = err?.code;
			if (code === "ECONNREFUSED" || code === "EHOSTUNREACH") {
				return false; // pretend no listener → EventEmitter stays quiet
			}
		}
		return originalEmit.call(this, event, ...args);
	};
	proto[SUPPRESS_MARKER] = true;

	return () => {
		proto.emit = originalEmit;
		proto[SUPPRESS_MARKER] = false;
	};
};

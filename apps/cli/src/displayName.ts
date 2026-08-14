import { hostname } from "node:os";

/**
 * Resolve the display name broadcast over mDNS.
 *
 * - When the user passed one on the command line (`wenchat alice`), use
 *   it verbatim. Anything else would silently rename a nickname they
 *   picked on purpose.
 * - Otherwise fall back to `os.hostname()` so the peer list on the other
 *   side at least names the machine (`kisser-macbook`, `studio-pc`, …)
 *   instead of a fresh random `user-1234` that means nothing.
 *
 * Note: the hostname is *read*, never written. WenChat does not touch
 * `/etc/hostname`, `scutil`, or any OS-level name. The mDNS instance
 * name we publish is still `${displayName}-<6-hex of localId>`, so the
 * hostname only shows up in the `displayName` field of our TXT record
 * — peers receive it as a friendly label, not as an mDNSResponder-managed
 * name. See the comment at the top of `main.tsx` for the full story.
 *
 * `os.hostname()` is documented to never throw and to never return an
 * empty string on a POSIX host; the trailing `|| "user"` is defensive
 * paranoia for exotic environments where the syscall might still
 * surprise us.
 */
export function resolveDisplayName(positional: readonly string[]): string {
	return positional[0] || hostname() || "user";
}

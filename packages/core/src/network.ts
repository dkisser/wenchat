import { networkInterfaces } from "node:os";

/**
 * Pick the first non-loopback IPv4 address from the host's network interfaces.
 * Used as the bind/announce host for the LAN signaling server so that we don't
 * fall back to 127.0.0.1 (which prevents LAN peers from connecting) and don't
 * bind on 0.0.0.0 (which would also expose the port to any reachable interface,
 * including WAN / port-forwarded paths).
 */
export function getLanHost(): string {
	const interfaces = networkInterfaces();
	for (const name of Object.keys(interfaces)) {
		for (const iface of interfaces[name] ?? []) {
			if (iface.family === "IPv4" && !iface.internal) {
				return iface.address;
			}
		}
	}
	return "127.0.0.1";
}

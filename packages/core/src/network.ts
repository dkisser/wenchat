import { type NetworkInterfaceInfo, networkInterfaces } from "node:os";

/** Shape returned by `os.networkInterfaces()`. */
export type NetworkInterfaceRecord = NodeJS.Dict<NetworkInterfaceInfo[]>;

/**
 * - `lan` — a concrete non-internal IPv4; reachable by peers on the same network.
 * - `loopback` — `127.0.0.1`; usable for two clients on one machine, invisible to the LAN.
 * - `any` — `0.0.0.0`; binds every NIC. Never advertise this one verbatim
 *   (see {@link resolveAdvertiseHost}).
 */
export type BindCandidateKind = "lan" | "loopback" | "any";

export type BindCandidate = {
	readonly address: string;
	/** NIC name from `os.networkInterfaces()`, e.g. "en0". Empty for `any`. */
	readonly interfaceName: string;
	readonly kind: BindCandidateKind;
};

export const LOOPBACK_HOST = "127.0.0.1";
export const ANY_HOST = "0.0.0.0";

/**
 * Every address the signaling server could bind to, for the startup picker.
 *
 * Ordering is LAN addresses first — in `os.networkInterfaces()` enumeration
 * order — then loopback, then the wildcard. The enumeration order is load
 * bearing rather than cosmetic: it makes the first entry identical to
 * {@link getLanHost}, which is what a non-interactive run binds. Sorting by
 * NIC name instead would silently pick a different address than the CLI
 * default on any host whose enumeration order is not alphabetical.
 *
 * `interfaces` is injectable so tests can describe a multi-homed host without
 * depending on the machine running them.
 */
export function listBindCandidates(
	interfaces: NetworkInterfaceRecord = networkInterfaces(),
): readonly BindCandidate[] {
	const lan: BindCandidate[] = [];
	let loopbackInterfaceName = "";

	for (const name of Object.keys(interfaces)) {
		for (const iface of interfaces[name] ?? []) {
			if (iface.family !== "IPv4") continue;
			if (iface.internal) {
				if (!loopbackInterfaceName && iface.address === LOOPBACK_HOST) {
					loopbackInterfaceName = name;
				}
				continue;
			}
			lan.push({ address: iface.address, interfaceName: name, kind: "lan" });
		}
	}

	return [
		...lan,
		{ address: LOOPBACK_HOST, interfaceName: loopbackInterfaceName, kind: "loopback" },
		{ address: ANY_HOST, interfaceName: "", kind: "any" },
	];
}

/**
 * Pick the first non-loopback IPv4 address from the host's network interfaces.
 * Used as the bind/announce host for the LAN signaling server so that we don't
 * fall back to 127.0.0.1 (which prevents LAN peers from connecting) and don't
 * bind on 0.0.0.0 (which would also expose the port to any reachable interface,
 * including WAN / port-forwarded paths).
 */
export function getLanHost(interfaces: NetworkInterfaceRecord = networkInterfaces()): string {
	for (const candidate of listBindCandidates(interfaces)) {
		if (candidate.kind === "lan") return candidate.address;
	}
	return LOOPBACK_HOST;
}

/**
 * The address to publish to peers for a given bind address.
 *
 * Binding `0.0.0.0` listens on every NIC, but `"0.0.0.0"` is meaningless as a
 * dial-back target: a peer that reads it out of our mDNS TXT record — or out
 * of the `signalingHost` field on our SDP offer — would resolve it to its own
 * loopback and never reach us. Substitute the LAN IPv4 in that one case; every
 * other bind address is already its own advertise address.
 */
export function resolveAdvertiseHost(
	bindHost: string,
	interfaces: NetworkInterfaceRecord = networkInterfaces(),
): string {
	return bindHost === ANY_HOST ? getLanHost(interfaces) : bindHost;
}

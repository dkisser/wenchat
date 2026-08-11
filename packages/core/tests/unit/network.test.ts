import { describe, expect, it } from "bun:test";
import type { NetworkInterfaceInfo } from "node:os";
import {
	ANY_HOST,
	LOOPBACK_HOST,
	getLanHost,
	listBindCandidates,
	resolveAdvertiseHost,
} from "../../src/network";

function ipv4(address: string, internal = false): NetworkInterfaceInfo {
	return {
		address,
		netmask: "255.255.255.0",
		family: "IPv4",
		mac: "00:00:00:00:00:00",
		internal,
		cidr: `${address}/24`,
	};
}

function ipv6(address: string, internal = false): NetworkInterfaceInfo {
	return {
		address,
		netmask: "ffff:ffff:ffff:ffff::",
		family: "IPv6",
		mac: "00:00:00:00:00:00",
		internal,
		cidr: `${address}/64`,
		scopeid: 0,
	};
}

const LOOPBACK_ONLY = { lo0: [ipv4(LOOPBACK_HOST, true), ipv6("::1", true)] };

const TWO_NICS = {
	lo0: [ipv4(LOOPBACK_HOST, true)],
	en0: [ipv4("192.168.1.42")],
	eth0: [ipv4("10.0.0.5")],
};

describe("listBindCandidates", () => {
	it("preserves OS enumeration order for LAN entries", () => {
		const candidates = listBindCandidates(TWO_NICS);
		const lan = candidates.filter((c) => c.kind === "lan");
		expect(lan.map((c) => c.address)).toEqual(["192.168.1.42", "10.0.0.5"]);
		expect(lan.map((c) => c.interfaceName)).toEqual(["en0", "eth0"]);
	});

	it("always ends with loopback then any", () => {
		const candidates = listBindCandidates(TWO_NICS);
		expect(candidates.at(-2)).toEqual({
			address: LOOPBACK_HOST,
			interfaceName: "lo0",
			kind: "loopback",
		});
		expect(candidates.at(-1)).toEqual({ address: ANY_HOST, interfaceName: "", kind: "any" });
	});

	it("still emits loopback and any when no LAN interface exists", () => {
		const candidates = listBindCandidates(LOOPBACK_ONLY);
		expect(candidates.map((c) => c.kind)).toEqual(["loopback", "any"]);
	});

	it("gives each IPv4 on a multi-address NIC its own row", () => {
		const candidates = listBindCandidates({
			en0: [ipv4("192.168.1.42"), ipv4("192.168.1.43")],
		});
		const lan = candidates.filter((c) => c.kind === "lan");
		expect(lan.map((c) => c.address)).toEqual(["192.168.1.42", "192.168.1.43"]);
		expect(lan.every((c) => c.interfaceName === "en0")).toBe(true);
	});

	it("excludes IPv6 entirely", () => {
		const candidates = listBindCandidates({
			en0: [ipv6("fe80::1"), ipv4("192.168.1.42")],
		});
		expect(candidates.filter((c) => c.kind === "lan").map((c) => c.address)).toEqual([
			"192.168.1.42",
		]);
	});

	it("leaves interfaceName empty when the host reports no 127.0.0.1", () => {
		const candidates = listBindCandidates({ en0: [ipv4("192.168.1.42")] });
		expect(candidates.at(-2)).toEqual({
			address: LOOPBACK_HOST,
			interfaceName: "",
			kind: "loopback",
		});
	});
});

describe("getLanHost", () => {
	it("returns the first non-internal IPv4 in enumeration order", () => {
		expect(getLanHost(TWO_NICS)).toBe("192.168.1.42");
	});

	it("falls back to loopback when only internal interfaces exist", () => {
		expect(getLanHost(LOOPBACK_ONLY)).toBe(LOOPBACK_HOST);
	});

	it("skips IPv6 addresses", () => {
		expect(getLanHost({ en0: [ipv6("fe80::1"), ipv4("192.168.1.42")] })).toBe("192.168.1.42");
	});

	it("agrees with the first LAN candidate — the picker's default must match the CLI default", () => {
		// scripts/smoke-lan-bind.ts and the non-TTY fallback both depend on
		// getLanHost(); if the candidate ordering ever diverges from it, the
		// address the picker highlights first would not be the one a
		// non-interactive run binds.
		const first = listBindCandidates(TWO_NICS).find((c) => c.kind === "lan");
		expect(first?.address).toBe(getLanHost(TWO_NICS));
	});
});

describe("resolveAdvertiseHost", () => {
	it("substitutes the LAN IPv4 for the wildcard bind address", () => {
		// A peer that receives "0.0.0.0" would dial its own loopback.
		expect(resolveAdvertiseHost(ANY_HOST, TWO_NICS)).toBe("192.168.1.42");
	});

	it("returns every other bind address unchanged", () => {
		expect(resolveAdvertiseHost("192.168.1.42", TWO_NICS)).toBe("192.168.1.42");
		expect(resolveAdvertiseHost(LOOPBACK_HOST, TWO_NICS)).toBe(LOOPBACK_HOST);
	});

	it("degrades to loopback for a wildcard bind on a host with no LAN interface", () => {
		expect(resolveAdvertiseHost(ANY_HOST, LOOPBACK_ONLY)).toBe(LOOPBACK_HOST);
	});
});

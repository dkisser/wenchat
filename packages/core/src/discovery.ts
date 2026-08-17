import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PeerInfo } from "@wenchat/protocol";
import Bonjour from "bonjour-service";
import { getLogger } from "./logger";

const SERVICE_TYPE = "wenchat";
const SERVICE_PROTOCOL = "tcp";

const DEFAULT_LOCAL_ID_PATH = join(homedir(), ".wenchat", "local-id");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type BonjourServiceLike = {
	stop: (callback: () => void) => void;
	on: (event: "up" | "error", handler: (arg?: unknown) => void) => void;
};

type BonjourBrowserLike = {
	stop: () => void;
	on: (event: "up" | "down", handler: (service: unknown) => void) => void;
};

type BonjourLike = {
	publish: (opts: Record<string, unknown>) => BonjourServiceLike;
	find: (opts: Record<string, unknown>) => BonjourBrowserLike;
	destroy?: (cb?: () => void) => void;
};

export type DiscoveryServiceOptions = {
	/**
	 * Override the local mDNS peer ID. When provided, `localIdPath` is ignored
	 * and the file system is never touched. Mainly for tests and for any
	 * future caller that already knows its ID.
	 */
	localId?: string;
	/**
	 * Where to persist the auto-generated local ID. Defaults to
	 * `~/.wenchat/local-id`. Passing a temp path is the recommended way to
	 * isolate tests from the user's real wenchat directory.
	 */
	localIdPath?: string;
};

export class DiscoveryService {
	private bonjour: BonjourLike;
	private service?: BonjourServiceLike;
	private browser?: BonjourBrowserLike;
	private peers: Record<string, PeerInfo> = {};
	private listeners: Set<(peers: PeerInfo[]) => void> = new Set();
	private localId: string;

	constructor(bonjour?: BonjourLike, options: DiscoveryServiceOptions = {}) {
		this.bonjour =
			bonjour ??
			(new Bonjour(undefined, (err: unknown) => {
				// Never stderr — the CLI runs an alt-screen TUI. The daily log
				// file under the workspace root's logs/ gets mDNS errors instead.
				getLogger().error({ err: getErrorMessage(err) }, "mDNS error");
			}) as unknown as BonjourLike);
		this.localId =
			options.localId ?? loadOrCreateLocalId(options.localIdPath ?? DEFAULT_LOCAL_ID_PATH);
	}

	async start(
		displayName: string,
		signalingPort: number,
		signalingHost = "127.0.0.1",
	): Promise<void> {
		// Boundary guard: callers (notably `App.tsx` in the CLI) hand us the
		// port the HTTP signaling server actually bound. If that thread
		// races — or somebody forgets to read `getSignalingPort()` first —
		// a `0` would otherwise sneak into both the SRV record and the TXT
		// record, and `parseService` would then drop the peer entirely on
		// the receiving side. Reject at the boundary so the bug surfaces
		// immediately, not as "why doesn't the other side show up in the
		// peer list?". `0` is a legitimate "OS, pick for me" signal for
		// `server.listen()` but not for what we advertise.
		if (signalingPort <= 0) {
			throw new Error(
				`DiscoveryService.start: signalingPort must be > 0 (the port actually bound by the signaling server); got ${signalingPort}`,
			);
		}
		return new Promise((resolve, reject) => {
			// The `name` below is a Bonjour/mDNS service instance name,
			// published over multicast DNS (224.0.0.251) only for the lifetime
			// of this process. We pair it with a stable `localId` (see
			// `loadOrCreateLocalId`) so subsequent CLI runs register the same
			// instance name — otherwise macOS mDNSResponder would resolve the
			// conflict (RFC 6762 §8.1) by appending `-1`, `-2`, … and the
			// "Computer Name Follows Hostname" toggle would sync that chaos
			// into `scutil --get LocalHostName`.
			//
			// We additionally pass `host: signalingHost` so the SRV record's
			// target is an IP literal — belt-and-suspenders against the same
			// mDNSResponder feature ever deciding to sync hostname-strings
			// instead. We never read `os.hostname()` for this purpose; the
			// value here is either a LAN IPv4 or `127.0.0.1`.
			const published = this.bonjour.publish({
				name: `${displayName}-${this.localId.slice(0, 6)}`,
				host: signalingHost,
				type: SERVICE_TYPE,
				protocol: SERVICE_PROTOCOL,
				port: signalingPort,
				txt: {
					id: this.localId,
					displayName,
					signalingHost,
					signalingPort: String(signalingPort),
				},
			});
			this.service = published;

			this.service.on("up", () => resolve());
			this.service.on("error", (arg?: unknown) => reject(getErrorMessage(arg)));

			this.browser = this.bonjour.find({
				type: SERVICE_TYPE,
				protocol: SERVICE_PROTOCOL,
			});
			this.browser.on("up", (service) => this.handleServiceUp(service));
			this.browser.on("down", (service) => this.handleServiceDown(service));
		});
	}

	async stop(): Promise<void> {
		return new Promise((resolve) => {
			this.browser?.stop();
			if (this.service) {
				this.service.stop(() => resolve());
			} else {
				resolve();
			}
		});
	}

	getPeers(): PeerInfo[] {
		return Object.values(this.peers);
	}

	onPeersUpdated(callback: (peers: PeerInfo[]) => void): () => void {
		this.listeners.add(callback);
		return () => {
			this.listeners.delete(callback);
		};
	}

	private handleServiceUp(service: unknown): void {
		const parsed = parseService(service);
		if (!parsed || parsed.id === this.localId) return;

		this.peers = { ...this.peers, [parsed.id]: parsed };
		this.notifyListeners();
	}

	private handleServiceDown(service: unknown): void {
		const parsed = parseService(service);
		if (!parsed || parsed.id === this.localId) return;

		const { [parsed.id]: _removed, ...rest } = this.peers;
		this.peers = rest;
		this.notifyListeners();
	}

	private notifyListeners(): void {
		const peers = this.getPeers();
		for (const listener of this.listeners) {
			listener(peers);
		}
	}
}

function parseService(service: unknown): PeerInfo | null {
	if (typeof service !== "object" || service === null) return null;

	const s = service as Record<string, unknown>;
	const txt = s.txt as Record<string, string> | undefined;
	if (!txt || typeof txt.id !== "string") return null;

	const addresses = Array.isArray(s.addresses) ? s.addresses : [];
	const signalingPort = Number(txt.signalingPort) || Number(s.port) || 0;
	if (signalingPort <= 0) return null;

	return {
		id: txt.id,
		displayName: txt.displayName || String(s.name || txt.id),
		signalingHost: txt.signalingHost || String(addresses[0] || s.host || "127.0.0.1"),
		signalingPort,
	};
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return "Unexpected error";
}

/**
 * Resolve a stable local peer ID. Reads it from `path` if it exists and is a
 * valid UUID; otherwise generates a fresh UUID, persists it to `path`, and
 * returns it. Persistence failures (permission denied, full disk) are
 * tolerated by returning the freshly generated ID anyway — the current
 * process still works, only the next launch will conflict again.
 *
 * `localId` exists so that the Bonjour instance name `<displayName>-<6-hex>`
 * stays stable across CLI runs. Without this, every launch looks like a new
 * Bonjour service to macOS mDNSResponder, which then resolves the conflict
 * by appending `-1`, `-2`, … and (with "Computer Name Follows Hostname"
 * enabled) syncs the result into `scutil --get LocalHostName`.
 */
function loadOrCreateLocalId(path: string): string {
	let existing: string | undefined;
	try {
		existing = readFileSync(path, "utf-8").trim();
	} catch {
		// File missing or unreadable — fall through to generate a fresh ID.
	}
	if (existing && UUID_PATTERN.test(existing)) {
		return existing;
	}

	const fresh = randomUUID();
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, fresh, { mode: 0o600 });
	} catch {
		// Persistence is best-effort. The current run still needs an ID.
	}
	return fresh;
}

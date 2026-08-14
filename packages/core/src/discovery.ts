import { randomUUID } from "node:crypto";
import type { PeerInfo } from "@wenchat/protocol";
import Bonjour from "bonjour-service";

const SERVICE_TYPE = "wenchat";
const SERVICE_PROTOCOL = "tcp";

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

export class DiscoveryService {
	private bonjour: BonjourLike;
	private service?: BonjourServiceLike;
	private browser?: BonjourBrowserLike;
	private peers: Record<string, PeerInfo> = {};
	private listeners: Set<(peers: PeerInfo[]) => void> = new Set();
	private localId: string = randomUUID();

	constructor(bonjour?: BonjourLike) {
		this.bonjour =
			bonjour ??
			(new Bonjour(undefined, (err: unknown) => {
				const message = getErrorMessage(err);
				process.stderr.write(`[discovery] mDNS error: ${message}\n`);
			}) as unknown as BonjourLike);
	}

	async start(
		displayName: string,
		signalingPort: number,
		signalingHost = "127.0.0.1",
	): Promise<void> {
		return new Promise((resolve, reject) => {
			// The `name` below is a Bonjour/mDNS service instance name. It is
			// published over multicast DNS (224.0.0.251) only for the lifetime of
			// this process and has no relationship to the system hostname. macOS
			// may display it in Finder → Network or System Settings → Sharing,
			// which is purely cosmetic and not a real hostname mutation.
			const published = this.bonjour.publish({
				name: `${displayName}-${this.localId.slice(0, 6)}`,
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

import Bonjour from "bonjour-service";
import type { PeerInfo } from "@wenchat/protocol";
import { randomUUID } from "node:crypto";

const SERVICE_TYPE = "wenchat";
const SERVICE_PROTOCOL = "tcp";

type BonjourLike = {
	publish: (opts: Record<string, unknown>) => {
		service: {
			stop: (cb: () => void) => void;
			on: (event: "up" | "error", handler: (arg?: unknown) => void) => void;
		};
	};
	find: (opts: Record<string, unknown>) => {
		stop: () => void;
		on: (event: "up" | "down", handler: (service: unknown) => void) => void;
	};
};

export class DiscoveryService {
	private bonjour: BonjourLike;
	private service?: ReturnType<BonjourLike["publish"]>["service"];
	private browser?: ReturnType<BonjourLike["find"]>;
	private peers: Record<string, PeerInfo> = {};
	private listeners: Set<(peers: PeerInfo[]) => void> = new Set();
	private localId: string = randomUUID();

	constructor(bonjour?: BonjourLike) {
		this.bonjour = bonjour ?? (new Bonjour() as unknown as BonjourLike);
	}

	async start(displayName: string, signalingPort: number): Promise<void> {
		return new Promise((resolve, reject) => {
			const published = this.bonjour.publish({
				name: `${displayName}-${this.localId.slice(0, 6)}`,
				type: SERVICE_TYPE,
				protocol: SERVICE_PROTOCOL,
				port: signalingPort,
				txt: {
					id: this.localId,
					displayName,
					signalingPort: String(signalingPort),
				},
			});
			this.service = published.service;

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
		signalingHost: String(addresses[0] || s.host || "127.0.0.1"),
		signalingPort,
	};
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return "Unexpected error";
}

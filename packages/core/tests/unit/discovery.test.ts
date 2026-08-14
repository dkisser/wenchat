import { describe, expect, it } from "bun:test";
import { DiscoveryService } from "../../src/discovery";

function createMockBonjour() {
	const listeners: {
		up?: (service: unknown) => void;
		down?: (service: unknown) => void;
	} = {};
	const published: unknown[] = [];

	return {
		publish: (opts: Record<string, unknown>) => {
			published.push(opts);
			// Real `bonjour-service` returns the Service EventEmitter directly
			// (no `{ service }` wrapper). The previous mock returned
			// `{ service }`, which papered over a real bug — see the
			// `regression: bonjour-service` test below.
			const service = {
				stop: (cb: () => void) => cb(),
				on: (event: "up" | "error", handler: (arg?: unknown) => void) => {
					if (event === "up") {
						queueMicrotask(() => handler());
					}
				},
			};
			return service;
		},
		find: (_opts: unknown) => {
			return {
				stop: () => {},
				on: (event: "up" | "down", handler: (service: unknown) => void) => {
					listeners[event] = handler;
				},
			};
		},
		emitUp: (service: unknown) => listeners.up?.(service),
		emitDown: (service: unknown) => listeners.down?.(service),
		published,
	};
}

describe("DiscoveryService", () => {
	it("starts and stops without error", async () => {
		const bonjour = createMockBonjour();
		const service = new DiscoveryService(bonjour as never);
		await service.start("alice", 9001);
		expect(service.getPeers()).toEqual([]);
		expect(bonjour.published.length).toBe(1);
		await service.stop();
	});

	it("notifies when peer list changes", async () => {
		const bonjour = createMockBonjour();
		const service = new DiscoveryService(bonjour as never);
		const updates: unknown[] = [];
		service.onPeersUpdated((peers) => updates.push(peers));
		await service.start("alice", 9002);

		bonjour.emitUp({
			txt: { id: "peer-1", displayName: "bob", signalingPort: "9003" },
			addresses: ["127.0.0.1"],
			host: "bob.local",
			port: 9003,
		});

		expect(service.getPeers().length).toBe(1);
		expect(service.getPeers()[0].displayName).toBe("bob");
		expect(updates.length).toBe(1);

		bonjour.emitDown({
			txt: { id: "peer-1", displayName: "bob", signalingPort: "9003" },
		});

		expect(service.getPeers().length).toBe(0);
		expect(updates.length).toBe(2);

		await service.stop();
	});

	// Regression guard: `bonjour-service` v1.x returns the Service
	// EventEmitter directly from `publish()`, not `{ service }`. Reading
	// `published.service` would throw synchronously inside the start()
	// Promise executor, which the CLI swallows with `.catch(() => {})`,
	// leaving mDNS neither publishing nor browsing. Reproduce the real
	// shape so a future mock regression surfaces here, not in the user's
	// LAN.
	it("regression: bonjour-service returns Service, not { service }", async () => {
		const bonjour = createMockBonjour();
		const service = new DiscoveryService(bonjour as never);
		await expect(service.start("alice", 9004)).resolves.toBeUndefined();
		await service.stop();
	});
});

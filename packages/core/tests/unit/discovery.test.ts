import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

	// Regression guard: when `bonjour.publish({...})` is called without an
	// explicit `host`, bonjour-service v1.4.4 falls back to `os.hostname()`
	// for the SRV record's target. macOS mDNSResponder then mirrors the
	// instance name into System Settings → Sharing. Passing an IP literal
	// (LAN IP or 127.0.0.1) keeps the record off the hostname string path.
	it("passes signalingHost to bonjour.publish as host", async () => {
		const bonjour = createMockBonjour();
		const service = new DiscoveryService(bonjour as never, {
			localId: "11111111-2222-3333-4444-555555555555",
		});
		await service.start("alice", 9010, "192.168.1.42");
		expect(bonjour.published[0]).toMatchObject({ host: "192.168.1.42" });
		await service.stop();
	});

	it("defaults host to 127.0.0.1 when signalingHost is omitted", async () => {
		const bonjour = createMockBonjour();
		const service = new DiscoveryService(bonjour as never, {
			localId: "11111111-2222-3333-4444-555555555555",
		});
		await service.start("alice", 9011);
		expect(bonjour.published[0]).toMatchObject({ host: "127.0.0.1" });
		await service.stop();
	});
});

describe("DiscoveryService localId persistence", () => {
	let tmpRoot: string;
	let localIdPath: string;

	beforeEach(() => {
		// Each test gets its own subdirectory so the persistence file cannot
		// leak state between tests (the whole point of persistence is that
		// it survives across instances).
		tmpRoot = join(tmpdir(), `wenchat-discovery-${randomUUID()}`);
		localIdPath = join(tmpRoot, "local-id");
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("creates the local-id file on first start", async () => {
		const bonjour = createMockBonjour();
		const service = new DiscoveryService(bonjour as never, { localIdPath });
		await service.start("alice", 9020);

		expect(existsSync(localIdPath)).toBe(true);
		const written = readFileSync(localIdPath, "utf-8").trim();
		expect(written).toMatch(UUID_PATTERN);
		// The instance name embeds the first 6 hex chars of the localId, so
		// the persistence ↔ publish wiring is end-to-end observable here.
		const publishedName = (bonjour.published[0] as { name: string }).name;
		expect(publishedName).toBe(`alice-${written.slice(0, 6)}`);
		await service.stop();
	});

	it("reuses the same localId on subsequent starts", async () => {
		const bonjour = createMockBonjour();
		const first = new DiscoveryService(bonjour as never, { localIdPath });
		await first.start("alice", 9021);
		const firstName = (bonjour.published[0] as { name: string }).name;
		await first.stop();

		// New instance, same tmp directory → should observe the persisted
		// localId and reuse it, keeping the Bonjour instance name stable.
		const second = new DiscoveryService(bonjour as never, { localIdPath });
		await second.start("alice", 9021);
		const secondName = (bonjour.published[1] as { name: string }).name;
		expect(secondName).toBe(firstName);
		await second.stop();
	});

	it("regenerates localId when the file is deleted", async () => {
		const bonjour = createMockBonjour();
		const first = new DiscoveryService(bonjour as never, { localIdPath });
		await first.start("alice", 9022);
		const firstName = (bonjour.published[0] as { name: string }).name;
		await first.stop();

		rmSync(localIdPath);

		const second = new DiscoveryService(bonjour as never, { localIdPath });
		await second.start("alice", 9022);
		const secondName = (bonjour.published[1] as { name: string }).name;
		expect(secondName).not.toBe(firstName);
		expect(existsSync(localIdPath)).toBe(true);
		await second.stop();
	});

	it("regenerates localId when the file contents are not a valid UUID", async () => {
		// Seed the file with garbage so the constructor must reject it and
		// write a fresh UUID in its place.
		mkdirSync(tmpRoot, { recursive: true });
		writeFileSync(localIdPath, "not-a-uuid", "utf-8");

		const bonjour = createMockBonjour();
		const service = new DiscoveryService(bonjour as never, { localIdPath });
		await service.start("alice", 9023);

		const written = readFileSync(localIdPath, "utf-8").trim();
		expect(written).not.toBe("not-a-uuid");
		expect(written).toMatch(UUID_PATTERN);
		await service.stop();
	});

	it("accepts an explicit localId override without touching the filesystem", async () => {
		// The override path is the safety hatch for tests and for any
		// future caller that already knows its ID — it must not consult
		// `localIdPath` at all.
		const fixedId = "11111111-2222-3333-4444-555555555555";
		const bonjour = createMockBonjour();
		const service = new DiscoveryService(bonjour as never, {
			localId: fixedId,
			localIdPath,
		});
		await service.start("alice", 9024);

		expect((bonjour.published[0] as { name: string }).name).toBe(`alice-${fixedId.slice(0, 6)}`);
		expect(existsSync(localIdPath)).toBe(false);
		await service.stop();
	});
});

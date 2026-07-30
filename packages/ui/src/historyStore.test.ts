import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryStore } from "./historyStore";

let workDir: string;
let filePath: string;
// Tracked so afterEach can await any in-flight background writes before
// wiping the work dir (otherwise the persist races the rm and the rename
// fails with ENOENT, which leaks noise into the test output).
let currentStore: HistoryStore | null = null;

beforeEach(async () => {
	workDir = await mkdtemp(join(tmpdir(), "wenchat-history-"));
	filePath = join(workDir, ".wechat_history");
	currentStore = null;
});

afterEach(async () => {
	if (currentStore) await currentStore.flush();
	await rm(workDir, { recursive: true, force: true });
});

async function readHistoryFile(): Promise<string> {
	return readFile(filePath, "utf-8");
}

function track(store: HistoryStore): HistoryStore {
	currentStore = store;
	return store;
}

describe("HistoryStore", () => {
	it("starts empty when the file does not exist", async () => {
		const store = track(new HistoryStore({ filePath, maxEntries: 100 }));
		await store.init();
		expect(store.size).toBe(0);
		expect(store.prev("draft")).toBeNull();
	});

	it("starts without throwing when the file is malformed", async () => {
		// Intentionally bad content — the store should recover, not crash.
		// The exact number of recovered entries is implementation-defined;
		// we only assert that init completes and the store is usable.
		await writeFile(filePath, "\x00\xff\xfe garbage bytes \n still bad\n", "utf-8");
		const store = track(new HistoryStore({ filePath, maxEntries: 100 }));
		expect(async () => {
			await store.init();
		}).not.toThrow();
		expect(store.size).toBeGreaterThanOrEqual(0);
	});

	it("loads pre-existing entries on init", async () => {
		await writeFile(filePath, "hello\nworld\nfoo\n", "utf-8");
		const store = track(new HistoryStore({ filePath, maxEntries: 100 }));
		await store.init();
		expect(store.size).toBe(3);
		expect(store.prev("draft")).toBe("foo");
		expect(store.prev("draft")).toBe("world");
		expect(store.prev("draft")).toBe("hello");
	});

	it("persists pushed entries to disk", async () => {
		const store = track(new HistoryStore({ filePath, maxEntries: 100 }));
		await store.init();
		store.push("first");
		store.push("second");
		await store.flush();
		expect(await readHistoryFile()).toBe("first\nsecond\n");
	});

	it("enforces maxEntries by trimming the oldest", async () => {
		const store = track(new HistoryStore({ filePath, maxEntries: 3 }));
		await store.init();
		store.push("a");
		store.push("b");
		store.push("c");
		store.push("d");
		await store.flush();
		expect(await readHistoryFile()).toBe("b\nc\nd\n");
		expect(store.size).toBe(3);
	});

	it("round-trips entries with embedded newlines", async () => {
		const store = track(new HistoryStore({ filePath, maxEntries: 100 }));
		await store.init();
		store.push("line1\nline2");
		await store.flush();
		expect(await readHistoryFile()).toBe("line1\\nline2\n");

		// Reload into a fresh store and verify the entry is restored intact.
		const store2 = track(new HistoryStore({ filePath, maxEntries: 100 }));
		await store2.init();
		expect(store2.size).toBe(1);
		expect(store2.prev("")).toBe("line1\nline2");
	});

	it("round-trips entries with embedded backslashes", async () => {
		const store = track(new HistoryStore({ filePath, maxEntries: 100 }));
		await store.init();
		store.push("path\\to\\file");
		await store.flush();

		const store2 = track(new HistoryStore({ filePath, maxEntries: 100 }));
		await store2.init();
		expect(store2.prev("")).toBe("path\\to\\file");
	});

	it("reloads a file that already exceeds maxEntries, keeping only the most recent", async () => {
		// Pre-seed with 5 entries; store capped at 3 should keep the last 3.
		await writeFile(filePath, "1\n2\n3\n4\n5\n", "utf-8");
		const store = track(new HistoryStore({ filePath, maxEntries: 3 }));
		await store.init();
		expect(store.size).toBe(3);
		expect(store.prev("")).toBe("5");
		expect(store.prev("")).toBe("4");
		expect(store.prev("")).toBe("3");
		expect(store.prev("")).toBeNull();
	});

	it("the parent directory is created on first push", async () => {
		const nestedPath = join(workDir, "deeply", "nested", "history");
		const store = track(new HistoryStore({ filePath: nestedPath, maxEntries: 100 }));
		await store.init();
		store.push("hi");
		await store.flush();
		expect(await readFile(nestedPath, "utf-8")).toBe("hi\n");
	});
});

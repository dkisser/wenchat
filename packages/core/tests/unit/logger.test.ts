import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	_resetLoggerForTests,
	getLogDir,
	getLogFilePath,
	getLogger,
	getWorkspaceRoot,
	initLogger,
	pruneOldLogs,
} from "../../src/logger";

let scratchDir: string;

beforeEach(async () => {
	scratchDir = await mkdtemp(join(tmpdir(), "wenchat-logger-"));
});

afterEach(async () => {
	// Reset the process-wide logger BEFORE deleting the temp dir, so its
	// sonic-boom destination never points at a removed file (see
	// _resetLoggerForTests).
	_resetLoggerForTests();
	await rm(scratchDir, { recursive: true, force: true });
});

describe("getWorkspaceRoot", () => {
	const holder = globalThis as { __WENCHAT_VERSION__?: string };
	let saved: string | undefined;

	beforeEach(() => {
		saved = holder.__WENCHAT_VERSION__;
	});

	afterEach(() => {
		holder.__WENCHAT_VERSION__ = saved;
	});

	it("is ~/.wenchat for a packed release binary", () => {
		holder.__WENCHAT_VERSION__ = "v0.1.4";
		expect(getWorkspaceRoot()).toBe(join(homedir(), ".wenchat"));
		expect(getLogDir()).toBe(join(homedir(), ".wenchat", "logs"));
	});

	it("is the working directory for a dev run", () => {
		holder.__WENCHAT_VERSION__ = undefined;
		expect(getWorkspaceRoot()).toBe(process.cwd());
		expect(getLogDir()).toBe(join(process.cwd(), "logs"));
	});
});

describe("getLogDir / getLogFilePath", () => {
	it("nests logs under <root>/logs", () => {
		expect(getLogDir("/work/root")).toBe(join("/work/root", "logs"));
	});

	it("stamps the file name with the local date", () => {
		const date = new Date(2026, 7, 17, 23, 30);
		expect(getLogFilePath(date, "/work/root")).toBe(
			join("/work/root", "logs", "wenchat-2026-08-17.log"),
		);
	});
});

describe("pruneOldLogs", () => {
	it("deletes files older than the retention window and keeps recent ones", async () => {
		const now = new Date(2026, 7, 17, 12, 0);
		await writeFile(join(scratchDir, "wenchat-2026-08-17.log"), "today");
		await writeFile(join(scratchDir, "wenchat-2026-08-11.log"), "6 days ago — kept");
		await writeFile(join(scratchDir, "wenchat-2026-08-10.log"), "7 days ago — pruned");
		await writeFile(join(scratchDir, "wenchat-2026-07-01.log"), "ancient — pruned");

		await pruneOldLogs({ logDir: scratchDir, now });

		const remaining = (await readdir(scratchDir)).sort();
		expect(remaining).toEqual(["wenchat-2026-08-11.log", "wenchat-2026-08-17.log"]);
	});

	it("leaves files that do not match the log name pattern alone", async () => {
		await writeFile(join(scratchDir, "local-id"), "abc");
		await writeFile(join(scratchDir, "wenchat-old.log"), "legacy");
		await writeFile(join(scratchDir, "notes.txt"), "hello");

		await pruneOldLogs({ logDir: scratchDir, now: new Date(2026, 7, 17) });

		const remaining = (await readdir(scratchDir)).sort();
		expect(remaining).toEqual(["local-id", "notes.txt", "wenchat-old.log"]);
	});

	it("resolves silently when the log directory does not exist", async () => {
		await expect(
			pruneOldLogs({ logDir: join(scratchDir, "missing"), now: new Date() }),
		).resolves.toBeUndefined();
	});
});

describe("initLogger / getLogger", () => {
	it("writes parseable JSON lines to the date-stamped file", async () => {
		const now = new Date(2026, 7, 17, 10, 0);
		const logger = await initLogger({ logDir: scratchDir, now, level: "debug" });
		logger.warn({ code: "E_DEMO" }, "demo event");
		logger.flush();
		await new Promise((resolve) => setTimeout(resolve, 50));

		const content = await readFile(join(scratchDir, "wenchat-2026-08-17.log"), "utf8");
		const line = JSON.parse(content.trim());
		expect(line.level).toBe(40);
		expect(line.msg).toBe("demo event");
		expect(line.code).toBe("E_DEMO");
	});

	it("getLogger() returns the initialized logger afterwards", async () => {
		const now = new Date(2026, 7, 17, 10, 0);
		await initLogger({ logDir: scratchDir, now });
		expect(getLogger().level).toBe("info");
	});
});

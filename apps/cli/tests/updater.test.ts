import { describe, expect, test } from "bun:test";
import {
	type GitHubRelease,
	assetNameFor,
	detectTarget,
	findDownloadUrl,
	getCurrentVersion,
	isNewer,
} from "../src/updater";

describe("getCurrentVersion", () => {
	test('returns "dev" when no version is injected (dev / bun run cli)', () => {
		// globalThis.__WENCHAT_VERSION__ is undefined in this test environment
		// (we never set it, and esbuild --define is not applied to the test
		// bundle). This is the fallback the CLI relies on during development.
		expect(getCurrentVersion()).toBe("dev");
	});
});

describe("isNewer", () => {
	test("returns true when latest has a higher major", () => {
		expect(isNewer("v2.0.0", "v1.5.3")).toBe(true);
	});
	test("returns true when latest has a higher minor", () => {
		expect(isNewer("v0.2.0", "v0.1.9")).toBe(true);
	});
	test("returns true when latest has a higher patch", () => {
		expect(isNewer("v0.1.1", "v0.1.0")).toBe(true);
	});
	test("returns false when versions are equal", () => {
		expect(isNewer("v0.1.0", "v0.1.0")).toBe(false);
	});
	test("returns false when latest is older", () => {
		expect(isNewer("v0.1.0", "v0.2.0")).toBe(false);
	});
	test('returns true unconditionally when current is "dev"', () => {
		// "dev" installs should always be considered outdated so `wenchat upgrade`
		// overwrites a hand-built binary.
		expect(isNewer("v0.0.1", "dev")).toBe(true);
	});
	test("handles missing leading v on either side", () => {
		expect(isNewer("1.0.0", "0.9.0")).toBe(true);
		expect(isNewer("0.9.0", "1.0.0")).toBe(false);
	});
});

describe("assetNameFor", () => {
	test("names linux and darwin binaries without extension", () => {
		expect(assetNameFor("v0.1.0", "linux-x64")).toBe("wenchat-v0.1.0-linux-x64");
		expect(assetNameFor("v0.1.0", "darwin-arm64")).toBe("wenchat-v0.1.0-darwin-arm64");
	});
	test("appends .exe for windows", () => {
		expect(assetNameFor("v0.1.0", "windows-x64")).toBe("wenchat-v0.1.0-windows-x64.exe");
	});
});

describe("findDownloadUrl", () => {
	const release: GitHubRelease = {
		tag_name: "v0.1.0",
		assets: [
			{
				name: "wenchat-v0.1.0-linux-x64",
				browser_download_url: "https://example.com/linux",
			},
			{
				name: "wenchat-v0.1.0-darwin-arm64",
				browser_download_url: "https://example.com/darwin",
			},
			{
				name: "wenchat-v0.1.0-windows-x64.exe",
				browser_download_url: "https://example.com/windows",
			},
			{
				name: "SHA256SUMS",
				browser_download_url: "https://example.com/sums",
			},
		],
	};

	test("returns the matching asset URL", () => {
		expect(findDownloadUrl(release, "linux-x64")).toBe("https://example.com/linux");
		expect(findDownloadUrl(release, "darwin-arm64")).toBe("https://example.com/darwin");
		expect(findDownloadUrl(release, "windows-x64")).toBe("https://example.com/windows");
	});

	test("throws when the asset is missing", () => {
		const empty: GitHubRelease = { tag_name: "v0.1.0", assets: [] };
		expect(() => findDownloadUrl(empty, "linux-x64")).toThrow(/No asset named/);
	});
});

describe("detectTarget", () => {
	test("maps the current platform to a target string", () => {
		// We don't know what platform the test is running on, but the mapping
		// table is small — just check that we either get a valid target or a
		// recognized unsupported-platform error.
		const os = process.platform;
		const arch = process.arch;
		try {
			const t = detectTarget();
			expect(["linux-x64", "darwin-arm64", "windows-x64"]).toContain(t);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			expect(msg).toMatch(/^Unsupported platform|not in the build matrix$/);
			expect([`${os}-${arch}`]).toContain(
				os === "darwin" && arch === "x64" ? "darwin-x64" : `${os}-${arch}`,
			);
		}
	});
});

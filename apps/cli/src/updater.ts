// apps/cli/src/updater.ts
//
// Self-upgrade machinery for the packed wenchat binary. The version is injected
// at pack time via esbuild's `define`:
//   { define: { "globalThis.__WENCHAT_VERSION__": "\"v0.1.0\"" } }
// In dev (bun run cli) the global is undefined, so getCurrentVersion() returns
// "dev" and `wenchat upgrade` is happy to overwrite a "dev" install.
import { existsSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { execPath, stdout } from "node:process";

const REPO = "dkisser/wenchat";
const GITHUB_LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

type VersionHolder = { __WENCHAT_VERSION__?: string };
export type Target = "linux-x64" | "darwin-arm64" | "windows-x64";

const TARGET_TO_EXT: Record<Target, string> = {
	"linux-x64": "",
	"darwin-arm64": "",
	"windows-x64": ".exe",
};

// Mirrors the matrix in .github/workflows/release.yml. Kept in one place so
// install.sh, the GitHub workflow, and this updater can never disagree.
export function detectTarget(): Target {
	const os = platform();
	const arch = process.arch;
	if (os === "linux" && arch === "x64") return "linux-x64";
	if (os === "darwin" && arch === "arm64") return "darwin-arm64";
	if (os === "darwin" && arch === "x64") {
		throw new Error("Intel Mac (x86_64) is not in the build matrix. Build from source.");
	}
	if (os === "win32" && arch === "x64") return "windows-x64";
	throw new Error(`Unsupported platform: ${os}-${arch}`);
}

export function getCurrentVersion(): string {
	const injected = (globalThis as VersionHolder).__WENCHAT_VERSION__;
	return injected && typeof injected === "string" ? injected : "dev";
}

type GitHubAsset = { name: string; browser_download_url: string };
export type GitHubRelease = { tag_name: string; assets: GitHubAsset[] };

export async function getLatestRelease(): Promise<GitHubRelease> {
	const res = await fetch(GITHUB_LATEST_URL, {
		headers: { "User-Agent": "wenchat-updater" },
	});
	if (!res.ok) {
		throw new Error(`GitHub API responded ${res.status} ${res.statusText}`);
	}
	const data = (await res.json()) as GitHubRelease;
	if (!data.tag_name || !Array.isArray(data.assets)) {
		throw new Error("GitHub API response missing tag_name or assets");
	}
	return data;
}

export function assetNameFor(tag: string, target: Target): string {
	// tag carries the leading "v" (matches the GitHub Release tag, e.g. v0.1.0).
	return `wenchat-${tag}-${target}${TARGET_TO_EXT[target]}`;
}

export function findDownloadUrl(release: GitHubRelease, target: Target): string {
	const wanted = assetNameFor(release.tag_name, target);
	const asset = release.assets.find((a) => a.name === wanted);
	if (!asset) {
		const available = release.assets.map((a) => a.name).join(", ");
		throw new Error(
			`No asset named ${wanted} in release ${release.tag_name} (have: ${available || "none"})`,
		);
	}
	return asset.browser_download_url;
}

// Naive dotted-tuple compare. Sufficient until we ever ship a pre-release
// suffix (e.g. v0.1.0-rc.1), at which point we plug in semver.
export function isNewer(latest: string, current: string): boolean {
	if (current === "dev") return true;
	const strip = (s: string): number[] =>
		s
			.replace(/^v/, "")
			.split(".")
			.map((p) => Number.parseInt(p, 10) || 0);
	const a = strip(latest);
	const b = strip(current);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		if (x > y) return true;
		if (x < y) return false;
	}
	return false;
}

export async function runDownload(url: string, destPath: string): Promise<void> {
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok) {
		throw new Error(`Download failed: ${res.status} ${res.statusText}`);
	}
	const buf = Buffer.from(await res.arrayBuffer());
	await mkdir(resolve(destPath, ".."), { recursive: true });
	await writeFile(destPath, buf);
	if (!destPath.endsWith(".exe")) {
		await chmod(destPath, 0o755);
	}
}

export type DownloadResult = { path: string; replaced: boolean };

export async function downloadAndReplace(url: string, target: Target): Promise<DownloadResult> {
	const installPath = execPath;
	const ext = TARGET_TO_EXT[target];
	const tmpPath = join(homedir(), `.wenchat-update-${Date.now()}${ext}`);

	await runDownload(url, tmpPath);

	// Linux/macOS: a running executable CAN be atomically renamed over itself.
	// Windows: the .exe is locked while running; we leave the new file staged
	// and tell the user to swap it manually (no wenchat-updater.exe helper yet).
	if (platform() === "win32") {
		return { path: tmpPath, replaced: false };
	}
	if (!existsSync(installPath)) {
		// Running from a path that no longer exists (e.g. moved during dev).
		// Surface the staged file instead of silently swallowing.
		throw new Error(
			`Current executable not found at ${installPath}; new binary left at ${tmpPath}. Move it manually.`,
		);
	}
	await rename(tmpPath, installPath);
	return { path: installPath, replaced: true };
}

export type UpgradeOpts = { checkOnly?: boolean };

// Exit code contract (matches what `wenchat upgrade` returns to the shell):
//   0 = up to date OR upgraded successfully OR newer available (--check-only)
//   1 = network/IO error
//   2 = unsupported platform
//   3 = could not find an asset for this platform
export async function upgradeCli(opts: UpgradeOpts = {}): Promise<number> {
	const current = getCurrentVersion();
	stdout.write(`Current version: ${current}\n`);

	let release: GitHubRelease;
	try {
		release = await getLatestRelease();
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		process.stderr.write(`Failed to fetch latest release: ${msg}\n`);
		return 1;
	}
	const latest = release.tag_name;
	stdout.write(`Latest version:  ${latest}\n`);

	if (!isNewer(latest, current)) {
		stdout.write("Already on the latest version.\n");
		return 0;
	}
	if (opts.checkOnly) {
		stdout.write("A newer version is available. Run `wenchat upgrade` to install.\n");
		return 0;
	}

	let target: Target;
	try {
		target = detectTarget();
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		process.stderr.write(`${msg}\n`);
		return 2;
	}

	let url: string;
	try {
		url = findDownloadUrl(release, target);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		process.stderr.write(`${msg}\n`);
		return 3;
	}
	stdout.write(`Downloading ${assetNameFor(latest, target)} ...\n`);

	try {
		const result = await downloadAndReplace(url, target);
		if (result.replaced) {
			stdout.write(`Upgraded to ${latest} at ${result.path}.\n`);
			stdout.write("Restart any open shell to pick up the new binary.\n");
			return 0;
		}
		stdout.write(`Downloaded to ${result.path}.\n`);
		stdout.write("Windows cannot replace a running executable; please move it manually\n");
		stdout.write("over the current wenchat.exe and restart your shell.\n");
		return 0;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		process.stderr.write(`Upgrade failed: ${msg}\n`);
		return 1;
	}
}

// `wenchat help` body. Kept here (next to the other CLI-facing strings) so
// main.tsx stays a thin dispatch layer.
export const HELP_TEXT = `wenchat - LAN-only P2P terminal chat

Usage:
  wenchat start [options] [nickname] [signalingPort] [signalingHost]
  wenchat <subcommand> [options]

Subcommands:
  version              Print version and exit
  upgrade              Upgrade to the latest release
  upgrade --check-only Check for updates without installing
  help                 Print this help and exit

Start options:
  -n, --name <name>    Display name (default: hostname)
  -p, --port <port>    Signaling port (default: 0, OS-assigned)
      --host <host>    Bind host (omit for interactive picker)
      --no-mouse       Disable mouse tracking in the TUI

Examples:
  wenchat start alice
  wenchat start --name alice --port 9000 --host 192.168.1.100
  wenchat start alice 9000 192.168.1.100
  wenchat upgrade

Repository: https://github.com/dkisser/wenchat
`;

// Re-exports kept here for any future test wiring.
// (No runtime callers; left as a documentation anchor for the helpers above.)
export const _internal_anchors = { getCurrentVersion, detectTarget, isNewer };

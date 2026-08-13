#!/usr/bin/env bun
// scripts/package-cli.ts
//
// Bundle @wenchat/cli into a single platform binary using @yao-pkg/packer
// (Node SEA + auto-handled native bindings — see plans/ci-release-release-cli-linear-clock.md).
//
// Usage:
//   bun scripts/package-cli.ts --target linux-x64 --tag v0.1.0
//   bun run package:cli --target darwin-arm64 --tag v0.1.0
//
// Output:
//   dist-release/wenchat          (linux / darwin)
//   dist-release/wenchat.exe      (windows)
//
// Prerequisites (CI / local):
//   1. bun install --frozen-lockfile   # workspace:* symlinks must be present
//   2. bun run build                   # populates apps/cli/dist/ (the entry)
//
// The version is injected at pack time via esbuild's `define`:
//   globalThis.__WENCHAT_VERSION__  →  the value of --tag
// apps/cli/src/updater.ts reads it back at runtime; in dev (bun run cli) the
// global is undefined and getCurrentVersion() falls back to "dev".
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
// Pinned for reproducible builds. Bump intentionally, not by accident.
const PACKER_VERSION = "0.4.0";

type Target = "linux-x64" | "darwin-arm64" | "windows-x64";

const TARGET_TO_PACKER: Record<Target, string> = {
	"linux-x64": "node20-linux-x64",
	"darwin-arm64": "node20-darwin-arm64",
	"windows-x64": "node20-win-x64",
};

const TARGET_TO_EXT: Record<Target, string> = {
	"linux-x64": "",
	"darwin-arm64": "",
	"windows-x64": ".exe",
};

type CliArgs = { target: Target; tag: string };

function parseArgs(argv: string[]): CliArgs {
	let target: Target | null = null;
	let tag: string | null = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--target") {
			const v = argv[++i];
			if (v !== "linux-x64" && v !== "darwin-arm64" && v !== "windows-x64") {
				throw new Error(`Invalid --target: ${v} (expected linux-x64 | darwin-arm64 | windows-x64)`);
			}
			target = v;
		} else if (arg === "--tag") {
			const v = argv[++i];
			if (!v) throw new Error("Missing value for --tag");
			tag = v;
		}
	}
	if (!target) {
		throw new Error("Missing --target (linux-x64 | darwin-arm64 | windows-x64)");
	}
	if (!tag) {
		throw new Error("Missing --tag (e.g. v0.1.0)");
	}
	return { target, tag };
}

async function main(): Promise<void> {
	const { target, tag } = parseArgs(process.argv.slice(2));
	const packerPlatform = TARGET_TO_PACKER[target];
	const ext = TARGET_TO_EXT[target];
	const outDir = resolve(REPO_ROOT, "dist-release");
	const outFile = resolve(outDir, `wenchat${ext}`);

	// Refuse to bundle from source: packer reads apps/cli/package.json's `bin`
	// (./dist/main.js), which only exists after `bun run build`.
	const entry = resolve(REPO_ROOT, "apps/cli/dist/main.js");
	if (!existsSync(entry)) {
		throw new Error(`Entry not found: ${entry}\nRun \`bun run build\` first to populate dist/.`);
	}

	// Clean previous artifacts so a partial failure doesn't leave a stale binary
	// with the old version number.
	await rm(outDir, { recursive: true, force: true });
	await mkdir(outDir, { recursive: true });

	// esbuild `define` injects the version into globalThis.__WENCHAT_VERSION__,
	// which updater.ts reads at runtime. JSON.stringify of the tag produces a
	// quoted JS string literal that esbuild inlines verbatim.
	const esbuildOptions = {
		define: {
			"globalThis.__WENCHAT_VERSION__": JSON.stringify(tag),
		},
	};
	const esbuildOptionsJson = JSON.stringify(esbuildOptions);

	const packerArgs = [
		"-y",
		`@yao-pkg/packer@${PACKER_VERSION}`,
		"--targets",
		packerPlatform,
		"--output",
		outFile,
		"--options",
		esbuildOptionsJson,
	];

	process.stdout.write(`[package-cli] target: ${target}  (${packerPlatform})\n`);
	process.stdout.write(`[package-cli] tag:    ${tag}\n`);
	process.stdout.write(`[package-cli] entry:  ${entry}\n`);
	process.stdout.write(`[package-cli] output: ${outFile}\n`);

	// bunx is bun's equivalent of npx; the release workflow already runs under bun.
	const result = spawn({
		cmd: ["bunx", ...packerArgs],
		cwd: REPO_ROOT,
		stdio: ["inherit", "inherit", "inherit"],
	});
	const code = await result.exited;
	if (code !== 0) {
		throw new Error(`@yao-pkg/packer exited with code ${code}`);
	}
	process.stdout.write(`[package-cli] done: ${outFile}\n`);
}

main().catch((err: unknown) => {
	const msg = err instanceof Error ? err.message : String(err);
	process.stderr.write(`[package-cli] failed: ${msg}\n`);
	process.exit(1);
});

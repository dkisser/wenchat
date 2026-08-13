#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
// scripts/package-cli.ts
//
// Bundle @wenchat/cli into a single platform binary.
//
// Pipeline:
//   1. esbuild bundles apps/cli/dist/main.js with the version tag baked in
//      via `define: { "globalThis.__WENCHAT_VERSION__": "..." }`.
//   2. @yao-pkg/pkg takes that single-file bundle and packs it into a Node-SEA
//      binary that embeds the runtime and the yoga native binding. pkg's
//      `--options` is for v8 flags (e.g. --expose-gc), NOT esbuild defines,
//      so the define step has to happen before pkg sees the entry.
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
//   1. bun install                          # installs esbuild + @yao-pkg/pkg
//   2. bun run build                        # populates apps/cli/dist/main.js
import { spawn } from "bun";
import { build } from "esbuild";

const REPO_ROOT = resolve(import.meta.dir, "..");
// Pinned for reproducible builds. Bump intentionally, not by accident.
// Note: the package name is @yao-pkg/pkg (not @yao-pkg/packer — that name
// was retired; @yao-pkg/pkg is the maintained fork of vercel/pkg).
const PKG_VERSION = "6.22.0";

type Target = "linux-x64" | "darwin-arm64" | "windows-x64";

const TARGET_TO_PKG: Record<Target, string> = {
	// pkg's --targets strings reference node MAJOR only; pkg resolves the
	// latest available patch from yao-pkg/pkg-fetch releases (which ship
	// node-v22.x.y / node-v24.x.y / node-v26.x.y, not node20-* — the node20
	// target was inherited from vercel/pkg and has no prebuilt binary, which
	// silently triggers a from-source build that takes 20+ minutes).
	"linux-x64": "node22-linux-x64",
	"darwin-arm64": "node22-macos-arm64",
	"windows-x64": "node22-win-x64",
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
	const pkgPlatform = TARGET_TO_PKG[target];
	const ext = TARGET_TO_EXT[target];
	const outDir = resolve(REPO_ROOT, "dist-release");
	const outFile = resolve(outDir, `wenchat${ext}`);

	// Refuse to bundle from source: pkg reads the entry file as-is, and
	// apps/cli/dist/main.js only exists after `bun run build`.
	const entry = resolve(REPO_ROOT, "apps/cli/dist/main.js");
	if (!existsSync(entry)) {
		throw new Error(`Entry not found: ${entry}\nRun \`bun run build\` first to populate dist/.`);
	}

	// Clean previous artifacts so a partial failure doesn't leave a stale binary
	// with the old version number.
	await rm(outDir, { recursive: true, force: true });
	await mkdir(outDir, { recursive: true });

	const bundledEntry = join(outDir, "_entry.mjs");

	process.stdout.write(`[package-cli] target:    ${target}  (${pkgPlatform})\n`);
	process.stdout.write(`[package-cli] tag:       ${tag}\n`);
	process.stdout.write(`[package-cli] entry:     ${entry}\n`);
	process.stdout.write(`[package-cli] bundled:   ${bundledEntry}\n`);
	process.stdout.write(`[package-cli] output:    ${outFile}\n`);

	// Step 1: esbuild define injects the version into
	// globalThis.__WENCHAT_VERSION__, which apps/cli/src/updater.ts reads at
	// runtime via `globalThis as VersionHolder).__WENCHAT_VERSION__`. In dev
	// (bun run cli) the global is undefined and getCurrentVersion() falls back
	// to "dev". JSON.stringify(tag) produces a quoted JS string literal that
	// esbuild inlines verbatim — the value the embed sees at runtime is the
	// raw tag, no extra quotes.
	await build({
		entryPoints: [entry],
		bundle: true,
		outfile: bundledEntry,
		format: "esm",
		platform: "node",
		target: "node20",
		// Keep the original ESM entry shape so the top-level await in main.tsx
		// (the upgrade subcommand dispatch) survives the bundle.
		banner: {},
		define: {
			"globalThis.__WENCHAT_VERSION__": JSON.stringify(tag),
		},
		// ink imports react-devtools-core for its Devtools hook. esbuild
		// hoists the import to the top of the bundle so it is required at
		// module load time, independent of the DEV-conditional that gates
		// init_devtools(). Marking it `external` left a dangling require()
		// that pkg couldn't satisfy at runtime (no node_modules inside the
		// packed binary). Aliasing to the no-op stub ships the call site
		// with a valid module that no-ops on the few methods ink touches.
		alias: {
			"react-devtools-core": resolve(import.meta.dir, "devtools-stub.cjs"),
		},
		logLevel: "info",
	});

	// Step 2: pkg packs the bundled entry. Pass the bundled file as a
	// positional arg; pkg refuses to run without an input (we hit this exact
	// failure mode during the v0.1.0-dev packaging dry-run).
	const pkgArgs = [
		"-y",
		`@yao-pkg/pkg@${PKG_VERSION}`,
		"--targets",
		pkgPlatform,
		"--output",
		outFile,
		bundledEntry,
	];

	const proc = spawn(["bunx", ...pkgArgs], {
		cwd: REPO_ROOT,
		stdio: ["inherit", "inherit", "inherit"],
	});
	const code = await proc.exited;
	if (code !== 0) {
		throw new Error(`@yao-pkg/pkg exited with code ${code}`);
	}

	process.stdout.write(`[package-cli] done: ${outFile}\n`);
}

main().catch((err: unknown) => {
	const msg = err instanceof Error ? err.message : String(err);
	process.stderr.write(`[package-cli] failed: ${msg}\n`);
	process.exit(1);
});

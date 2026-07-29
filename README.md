# WenChat

A terminal-based LAN P2P chat and file-transfer client built with WebRTC data channels and mDNS discovery.

## Project Structure

This is a Bun/Node.js monorepo organized as follows:

- `apps/cli` – Terminal UI application powered by [Ink](https://github.com/vadimdemedes/ink)
- `packages/protocol` – Shared message protocol and serialization
- `packages/core` – WebRTC signaling, mDNS discovery, and networking logic
- `packages/ui` – Reusable terminal UI components

## Getting Started

Requires [Bun](https://bun.sh/) and Node.js >= 20.

```bash
bun install
bun run cli
```

## Scripts

- `bun run build` – Build all packages
- `bun test` – Run all tests
- `bun run lint` – Lint the codebase with Biome
- `bun run format` – Format the codebase with Biome
- `bun run cli` – Run the CLI application

## Tooling

- [Bun](https://bun.sh/) – Package manager, test runner, and build tool
- [Node.js](https://nodejs.org/) – Runtime for the CLI
- [TypeScript](https://www.typescriptlang.org/) – Type-safe JavaScript
- [Biome](https://biomejs.dev/) – Linting and formatting

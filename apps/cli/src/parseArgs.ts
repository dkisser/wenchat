import { resolveDisplayName } from "./displayName";

export type StartAction = {
	kind: "start";
	displayName: string;
	signalingPort: number;
	signalingHost: string | undefined;
	mouseEnabled: boolean;
};

export type CliAction =
	| { kind: "version" }
	| { kind: "help" }
	| { kind: "upgrade"; checkOnly: boolean }
	| StartAction;

export function parseCliArgs(argv: readonly string[]): CliAction {
	if (argv.length === 0) {
		return { kind: "help" };
	}

	const first = argv[0];

	if (first === "version" || first === "--version" || first === "-v") {
		return { kind: "version" };
	}
	if (first === "help" || first === "--help" || first === "-h") {
		return { kind: "help" };
	}
	if (first === "upgrade" || first === "update") {
		const checkOnly = argv.slice(1).includes("--check-only");
		return { kind: "upgrade", checkOnly };
	}
	if (first === "start") {
		return parseStartArgs(argv.slice(1));
	}

	throw new Error(`Unknown subcommand "${first}". Run "wenchat help".`);
}

function parseStartArgs(args: readonly string[]): StartAction {
	let displayName: string | undefined;
	let signalingPort: number | undefined;
	let signalingHost: string | undefined;
	let mouseEnabled = true;
	let valueFlagUsed = false;
	const positionals: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--no-mouse") {
			mouseEnabled = false;
			continue;
		}
		if (arg === "--name" || arg === "-n") {
			const next = args[++i];
			if (!next) {
				throw new Error("--name requires a value.");
			}
			valueFlagUsed = true;
			displayName = next;
			continue;
		}
		if (arg === "--port" || arg === "-p") {
			const next = args[++i];
			if (!next) {
				throw new Error("--port requires a value.");
			}
			valueFlagUsed = true;
			signalingPort = parsePort(next);
			continue;
		}
		if (arg === "--host") {
			const next = args[++i];
			if (!next) {
				throw new Error("--host requires a value.");
			}
			valueFlagUsed = true;
			signalingHost = next;
			continue;
		}
		if (arg.startsWith("--")) {
			throw new Error(`Unknown option "${arg}". Run "wenchat help".`);
		}

		positionals.push(arg);
	}

	if (valueFlagUsed && positionals.length > 0) {
		throw new Error(
			"Cannot combine --name/--port/--host with positional arguments. Use one style or the other.",
		);
	}

	const [positionalName, positionalPort, positionalHost] = positionals;

	return {
		kind: "start",
		displayName: displayName ?? positionalName ?? resolveDisplayName([]),
		signalingPort: signalingPort ?? (positionalPort ? parsePort(positionalPort) : 0),
		signalingHost: signalingHost ?? positionalHost,
		mouseEnabled,
	};
}

function parsePort(value: string): number {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error(`"${value}" is not a valid port.`);
	}
	return port;
}

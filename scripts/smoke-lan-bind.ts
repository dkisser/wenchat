import { networkInterfaces } from "node:os";
import { SignalingServer } from "@wenchat/core";

async function main() {
	const iface = networkInterfaces();
	let lanHost = "127.0.0.1";
	for (const name of Object.keys(iface)) {
		for (const i of iface[name] ?? []) {
			if (i.family === "IPv4" && !i.internal) {
				lanHost = i.address;
				break;
			}
		}
	}
	console.log(`[smoke] detected LAN host: ${lanHost}`);

	const server = new SignalingServer();
	await server.start(0, lanHost);
	const port = server.getPort();

	const listenerOnLoopback = await fetch(`http://127.0.0.1:${port}/offer`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ type: "offer", sdp: "x" }),
	}).catch((e: unknown) => ({ status: 0, err: String(e) }));

	const listenerOnLan = await fetch(`http://${lanHost}:${port}/offer`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ type: "offer", sdp: "x" }),
	}).catch((e: unknown) => ({ status: 0, err: String(e) }));

	console.log(
		`[smoke] 127.0.0.1:${port}/offer -> status=${"status" in listenerOnLoopback ? listenerOnLoopback.status : "n/a"}`,
	);
	console.log(
		`[smoke] ${lanHost}:${port}/offer -> status=${"status" in listenerOnLan ? listenerOnLan.status : "n/a"}`,
	);

	await server.stop();

	const lanOk = "status" in listenerOnLan && listenerOnLan.status >= 200;
	const loopbackBlocked = !("status" in listenerOnLoopback) || listenerOnLoopback.status === 0;

	if (lanOk && loopbackBlocked) {
		console.log("[smoke] PASS: LAN reachable, loopback correctly NOT bound");
	} else {
		console.log(`[smoke] FAIL: lanOk=${lanOk}, loopbackBlocked=${loopbackBlocked}`);
		process.exit(1);
	}
}

main().catch((e: unknown) => {
	console.error("[smoke] crashed:", e);
	process.exit(1);
});

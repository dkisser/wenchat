import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ByeReason } from "@wenchat/protocol";
import { getLogger } from "./logger";

export type SdpPayload = {
	type: string;
	sdp: string;
	signalingHost?: string;
	signalingPort?: number;
};

export type IceCandidatePayload = {
	candidate: string;
	sdpMid?: string;
	sdpMLineIndex?: number;
};

/**
 * Out-of-band teardown intent. This is the AUTHORITATIVE "I left on
 * purpose" signal — it travels over TCP, so the sender can await the 200
 * and know the peer recorded the reason before any WebRTC teardown
 * begins. The in-band DataChannel `bye` could never guarantee that: it
 * races the SCTP ABORT that `pc.close()` queues right behind it, and the
 * receiver may dispatch the close before the message.
 *
 * `fromHost`/`fromPort` identify the sender's own signaling endpoint.
 * The receiver matches them against its live session's remote endpoint so
 * a LATE bye (the sender tore down, we already moved on to a new peer)
 * cannot tear down the wrong session.
 */
export type ByePayload = {
	readonly reason: ByeReason;
	readonly fromHost: string;
	readonly fromPort: number;
};

/** Upper bound for the HTTP bye round trip. A `/exit` awaits this before
 * the process dies, so it must be bounded even when the peer's host is
 * unreachable (a TCP connect to a black-holed peer would otherwise stall
 * shutdown for the kernel's full connect timeout). */
export const BYE_TIMEOUT_MS = 1000;

/** Upper bound for the pre-reconnect liveness probe. */
export const PROBE_TIMEOUT_MS = 1000;

/**
 * What a liveness probe learned about a peer's signaling port.
 *
 * - `alive` — an HTTP response came back (any status; a 404 from an older
 *   build without `/health` still proves the process is up).
 * - `refused` — TCP ECONNREFUSED: the host is up but nothing listens, i.e.
 *   the peer's process exited. Retrying is pointless.
 * - `unreachable` — timeout or any other network error: a partition the
 *   peer cannot answer through. Retrying is the right call.
 */
export type ProbeResult = "alive" | "refused" | "unreachable";

/**
 * Walk the `cause` chain looking for a TCP-level connection refusal.
 * Two runtimes, two shapes: Node's undici wraps the socket error
 * (`cause.code === "ECONNREFUSED"`) in a `TypeError("fetch failed")`,
 * while Bun puts `code: "ConnectionRefused"` on the top-level error.
 * Tests run on Bun, the CLI on Node — both must classify as `refused`.
 */
function isConnectionRefused(err: unknown): boolean {
	let current: unknown = err;
	while (current instanceof Error) {
		const code = (current as { code?: string }).code;
		if (code === "ECONNREFUSED" || code === "ConnectionRefused") return true;
		current = current.cause;
	}
	return false;
}

/**
 * Probe a peer's signaling server to tell "process exited" apart from
 * "network partitioned" after a transport-level close. The reconnect
 * logic uses this to avoid redialing a peer that is simply gone.
 */
export async function probeSignaling(
	host: string,
	port: number,
	timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
	try {
		await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
		return "alive";
	} catch (err) {
		return isConnectionRefused(err) ? "refused" : "unreachable";
	}
}

/**
 * Hard cap on a signaling request body. SDP offers/answers and ICE
 * candidates are a few KiB at most; 256 KiB leaves generous headroom while
 * keeping a hostile LAN peer from buffering unbounded memory or hanging the
 * process on an unread multi-GB body.
 */
export const MAX_BODY_BYTES = 256 * 1024;

class BodyTooLargeError extends Error {
	constructor() {
		super(`request body exceeds ${MAX_BODY_BYTES} bytes`);
		this.name = "BodyTooLargeError";
	}
}

export class SignalingServer {
	private server?: Server;
	private offerCallback?: (offer: SdpPayload) => SdpPayload | Promise<SdpPayload>;
	private candidateCallback?: (candidate: IceCandidatePayload) => void;
	private byeCallback?: (bye: ByePayload) => void;

	async start(port: number, host = "0.0.0.0"): Promise<void> {
		return new Promise((resolve, reject) => {
			this.server = createServer((req, res) => this.handleRequest(req, res));
			this.server.once("error", reject);
			this.server.listen(port, host, () => {
				this.server?.off("error", reject);
				resolve();
			});
		});
	}

	async stop(): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!this.server) {
				resolve();
				return;
			}
			this.server.close((err) => {
				if (err) reject(err);
				else resolve();
			});
		});
	}

	getPort(): number {
		if (!this.server) return 0;
		const address = this.server.address() as AddressInfo;
		return address.port;
	}

	onOffer(callback: (offer: SdpPayload) => SdpPayload | Promise<SdpPayload>): () => void {
		this.offerCallback = callback;
		return () => {
			this.offerCallback = undefined;
		};
	}

	onCandidate(callback: (candidate: IceCandidatePayload) => void): () => void {
		this.candidateCallback = callback;
		return () => {
			this.candidateCallback = undefined;
		};
	}

	onBye(callback: (bye: ByePayload) => void): () => void {
		this.byeCallback = callback;
		return () => {
			this.byeCallback = undefined;
		};
	}

	async sendOffer(host: string, port: number, offer: SdpPayload): Promise<SdpPayload> {
		const response = await fetch(`http://${host}:${port}/offer`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(offer),
		});
		if (!response.ok) {
			throw new Error(`Signaling offer failed: ${response.status}`);
		}
		return (await response.json()) as SdpPayload;
	}

	async sendCandidate(host: string, port: number, candidate: IceCandidatePayload): Promise<void> {
		const response = await fetch(`http://${host}:${port}/candidate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(candidate),
		});
		if (!response.ok) {
			throw new Error(`Signaling candidate failed: ${response.status}`);
		}
	}

	/**
	 * Deliver teardown intent over TCP. Awaited by the graceful-close path:
	 * a resolved promise means the peer's `/bye` handler ran and the reason
	 * is recorded there — only then is it safe to tear down the WebRTC pc.
	 * Throws on non-2xx (e.g. a pre-`/bye` peer answering 404) and on
	 * network failure (ECONNREFUSED = peer already gone; timeout bounded by
	 * {@link BYE_TIMEOUT_MS}).
	 */
	async sendBye(
		host: string,
		port: number,
		reason: ByeReason,
		from: { readonly host: string; readonly port: number },
	): Promise<void> {
		const payload: ByePayload = { reason, fromHost: from.host, fromPort: from.port };
		const response = await fetch(`http://${host}:${port}/bye`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(BYE_TIMEOUT_MS),
		});
		if (!response.ok) {
			throw new Error(`Signaling bye failed: ${response.status}`);
		}
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = req.url || "";

		try {
			// readBody stays INSIDE the try: a peer that resets the socket
			// mid-body rejects the read, and that rejection must be caught
			// here — outside the try it becomes an unhandled rejection that
			// the terminal safety net turns into process.exit(1).
			const contentLength = Number(req.headers["content-length"] ?? 0);
			if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
				throw new BodyTooLargeError();
			}
			const body = await readBody(req);

			if (url === "/offer" && req.method === "POST") {
				const offer = JSON.parse(body) as SdpPayload;
				if (!this.offerCallback) {
					res.writeHead(503);
					res.end(JSON.stringify({ error: "Not ready" }));
					return;
				}
				const answer = await this.offerCallback(offer);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(answer));
			} else if (url === "/candidate" && req.method === "POST") {
				const candidate = JSON.parse(body) as IceCandidatePayload;
				this.candidateCallback?.(candidate);
				res.writeHead(200);
				res.end();
			} else if (url === "/bye" && req.method === "POST") {
				const bye = JSON.parse(body) as ByePayload;
				// Validate at the boundary — a garbage reason must not reach the
				// session layer, where it would map onto the CloseReason union.
				if (
					(bye.reason !== "exit" && bye.reason !== "disconnect") ||
					typeof bye.fromHost !== "string" ||
					!Number.isInteger(bye.fromPort) ||
					bye.fromPort <= 0
				) {
					res.writeHead(400, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Invalid bye payload" }));
					return;
				}
				this.byeCallback?.(bye);
				res.writeHead(200);
				res.end();
			} else if (url === "/health" && req.method === "GET") {
				// Liveness probe for the pre-reconnect check. The payload is
				// irrelevant — an answer of any kind proves the process is up.
				res.writeHead(200);
				res.end();
			} else {
				res.writeHead(404);
				res.end();
			}
		} catch (err) {
			getLogger().warn({ err: getErrorMessage(err), url }, "signaling request failed");
			// On a socket reset the response is already gone — writing to it
			// would throw a secondary error that masks the real one.
			if (res.destroyed || res.writableEnded) {
				return;
			}
			const tooLarge = err instanceof BodyTooLargeError;
			res.writeHead(tooLarge ? 413 : 400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: getErrorMessage(err) }));
			if (tooLarge) {
				// The rest of the oversized body may still be inbound; close the
				// socket once the 413 is flushed so it can't pile up unread.
				res.on("finish", () => req.socket.destroy());
			}
		}
	}
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let settled = false;
		const fail = (err: Error) => {
			if (!settled) {
				settled = true;
				reject(err);
			}
		};
		req.on("data", (chunk: Buffer) => {
			if (settled) return; // already rejected; discard the rest
			total += chunk.length;
			if (total > MAX_BODY_BYTES) {
				fail(new BodyTooLargeError());
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (!settled) {
				settled = true;
				resolve(Buffer.concat(chunks).toString("utf-8"));
			}
		});
		req.on("error", fail);
		// A reset socket emits "close" without "end"; don't leave the
		// handler promise pending forever.
		req.on("close", () => fail(new Error("connection closed before the body was fully read")));
	});
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return "Unexpected error";
}

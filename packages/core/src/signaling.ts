import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

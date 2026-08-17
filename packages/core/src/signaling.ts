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
		const body = await readBody(req);

		try {
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
			res.writeHead(400);
			res.end(JSON.stringify({ error: getErrorMessage(err) }));
		}
	}
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return "Unexpected error";
}

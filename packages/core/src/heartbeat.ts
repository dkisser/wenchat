import { randomUUID } from "node:crypto";
import { type Message, createPing, createPong } from "@wenchat/protocol";

export type HeartbeatSchedulerOptions = {
	send: (message: Message) => void;
	onTimeout: () => void;
	intervalMs?: number;
	timeoutMs?: number;
};

const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Application-layer heartbeat over the wenchat DataChannel.
 *
 * `start()` schedules a tick that emits a `ping` every `intervalMs`. A
 * watchdog fires `onTimeout` if no inbound ping/pong has been seen within
 * `timeoutMs`. Any inbound ping also auto-replies with a pong. This
 * single-tick-plus-watchdog shape handles BOTH "I sent a ping and got no
 * pong" and "I haven't heard anything from the peer" without piling up
 * orphaned timers.
 */
export class HeartbeatScheduler {
	private readonly send: (message: Message) => void;
	private readonly onTimeout: () => void;
	private readonly intervalMs: number;
	private readonly timeoutMs: number;

	private tickHandle: ReturnType<typeof setTimeout> | null = null;
	private watchdogHandle: ReturnType<typeof setTimeout> | null = null;
	private running = false;

	constructor(options: HeartbeatSchedulerOptions) {
		this.send = options.send;
		this.onTimeout = options.onTimeout;
		this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.scheduleTick();
		this.armWatchdog();
	}

	stop(): void {
		if (!this.running) return;
		this.running = false;
		this.clearTick();
		this.clearWatchdog();
	}

	handleIncoming(message: Message): void {
		if (message.type === "ping") {
			this.send(createPong(message.payload.nonce));
		}
		// Inbound ping/pong proves liveness — re-arm the watchdog. Text and
		// file traffic never reaches this scheduler (PeerConnection filters
		// them out before forwarding to user listeners), so they aren't a
		// concern here.
		if (message.type === "ping" || message.type === "pong") {
			this.armWatchdog();
		}
	}

	private scheduleTick(): void {
		if (!this.running) return;
		this.tickHandle = setTimeout(() => this.tick(), this.intervalMs);
	}

	private tick(): void {
		if (!this.running) return;
		this.send(createPing(randomUUID()));
		this.scheduleTick();
	}

	private armWatchdog(): void {
		if (!this.running) return;
		this.clearWatchdog();
		this.watchdogHandle = setTimeout(() => {
			if (!this.running) return;
			this.running = false;
			this.clearTick();
			this.clearWatchdog();
			this.onTimeout();
		}, this.timeoutMs);
	}

	private clearTick(): void {
		if (this.tickHandle !== null) {
			clearTimeout(this.tickHandle);
			this.tickHandle = null;
		}
	}

	private clearWatchdog(): void {
		if (this.watchdogHandle !== null) {
			clearTimeout(this.watchdogHandle);
			this.watchdogHandle = null;
		}
	}
}

import { randomUUID } from "node:crypto";
import { type Message, createPing, createPong } from "@wenchat/protocol";

export type HeartbeatSchedulerOptions = {
	send: (message: Message) => void;
	onTimeout: () => void;
	/**
	 * Optional gate: heartbeat only emits pings when this returns true. The
	 * caller uses it to avoid ticking into a transport that is not attached
	 * yet — for example, on the acceptor side WebRTC `connected` can fire
	 * before `ondatachannel`, and sending a ping without a DataChannel would
	 * throw. When the gate opens, the next scheduled tick fires normally.
	 */
	canSend?: () => boolean;
	intervalMs?: number;
	timeoutMs?: number;
};

const DEFAULT_INTERVAL_MS = 2000;
/** 15 s, not 4 s: the watchdog must outlive SCTP's own congestion recovery
 *  (T3-rtx doubles its RTO per failure, and a burst-loss episode can take
 *  many seconds to drain). A peer that is still delivering ANY inbound
 *  frame re-arms the watchdog via `noteInbound`, so this deadline only
 *  fires on total silence — a genuinely dead association, where 4 s
 *  killed healthy connections stuck behind a retransmit backlog
 *  (2026-09-21 incident: file transfer completes, connection dies). */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Application-layer heartbeat over the wenchat DataChannel.
 *
 * `start()` schedules a tick that emits a `ping` every `intervalMs`,
 * skipped while other inbound traffic has been seen within the interval
 * (that traffic already proved liveness — no point queueing a ping behind
 * it on a congested association). A watchdog fires `onTimeout` if NO
 * inbound frame at all (ping/pong, text, file chunk, or control ACK) has
 * been seen within `timeoutMs`; Session feeds every inbound frame to
 * `noteInbound`/`handleIncoming`. Any inbound ping also auto-replies with
 * a pong. This shape handles liveness without piling up orphaned timers,
 * and it never mistakes "peer is mid-transfer" for "peer is dead".
 */
export class HeartbeatScheduler {
	private readonly send: (message: Message) => void;
	private readonly onTimeout: () => void;
	private readonly canSend: () => boolean;
	private readonly intervalMs: number;
	private readonly timeoutMs: number;

	private tickHandle: ReturnType<typeof setTimeout> | null = null;
	private watchdogHandle: ReturnType<typeof setTimeout> | null = null;
	private running = false;
	/** Last time ANY inbound frame was seen (ping/pong, text, file chunk,
	 *  ACK). Null = nothing received yet. Drives both watchdog re-arming
	 *  (`noteInbound`) and idle detection for ping suppression. */
	private lastInboundAt: number | null = null;

	constructor(options: HeartbeatSchedulerOptions) {
		this.send = options.send;
		this.onTimeout = options.onTimeout;
		this.canSend = options.canSend ?? (() => true);
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
		// Any frame handled here is liveness proof too; the ping branch
		// additionally auto-replies with a pong.
		this.lastInboundAt = Date.now();
		this.armWatchdog();
		if (message.type === "ping") {
			this.send(createPong(message.payload.nonce));
		}
	}

	/**
	 * Record ANY inbound application traffic — text, file chunks, control
	 * ACKs — as liveness proof. During a bulk transfer the peer's pings
	 * queue behind megabytes of data and arrive late (or never), while
	 * chunk/ACK traffic keeps flowing; treating only ping/pong as liveness
	 * made the watchdog kill healthy mid-transfer connections. Safe to call
	 * for every inbound frame: it only re-arms a running watchdog and
	 * stamps the traffic clock.
	 */
	noteInbound(): void {
		this.lastInboundAt = Date.now();
		this.armWatchdog();
	}

	private scheduleTick(): void {
		if (!this.running) return;
		this.tickHandle = setTimeout(() => this.tick(), this.intervalMs);
	}

	private tick(): void {
		if (!this.running) return;
		// Suppress the ping when other traffic arrived within the last
		// interval: the peer's frames already proved liveness (and were
		// recorded via noteInbound/handleIncoming), so queueing a ping
		// behind them on a congested association buys nothing.
		const quiet = this.lastInboundAt === null || Date.now() - this.lastInboundAt >= this.intervalMs;
		if (this.canSend() && quiet) {
			this.send(createPing(randomUUID()));
		}
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

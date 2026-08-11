import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { DiscoveryService, PeerConnection } from "@wenchat/core";
import type { Message } from "@wenchat/protocol";
import { render } from "ink-testing-library";
import { App } from "../src/App";

describe("App", () => {
	let instance: ReturnType<typeof render> | null = null;

	afterEach(() => {
		instance?.unmount();
		instance = null;
	});

	it("renders status bar", () => {
		instance = render(<App displayName="alice" signalingPort={19001} signalingHost="127.0.0.1" />);
		expect(instance.lastFrame()).toContain("Offline");
	});

	it("keeps the input box as the last visible row", () => {
		// The reported bug: the input box scrolled off screen once the chat
		// log outgrew the terminal. With a fixed frame height, the InputBox
		// must always be the last frame row — its bottom border is the very
		// last line.
		instance = render(<App displayName="alice" signalingPort={19001} signalingHost="127.0.0.1" />);
		const frame = instance.lastFrame() ?? "";
		const lastLine = frame.split("\n").at(-1) ?? "";
		expect(lastLine.startsWith("└")).toBe(true);
		expect(lastLine.endsWith("┘")).toBe(true);
	});

	it("renders ChatView (not PeerList) when initialMessages is non-empty even while offline", () => {
		// After a remote /exit, the non-exiting side goes to status="offline"
		// but the chat history must stay on screen. The render branch is
		// `status === "offline" && messages.length === 0 ? <PeerList/> :
		// <ChatView/>`; this test seeds the log so messages.length > 0 and
		// asserts ChatView wins.
		const seed: Message[] = [
			{
				type: "text",
				id: "seed-1",
				timestamp: Date.now(),
				payload: { text: "previously sent message" },
			},
		];
		instance = render(
			<App
				displayName="alice"
				signalingPort={19001}
				signalingHost="127.0.0.1"
				initialMessages={seed}
			/>,
		);
		const frame = instance.lastFrame() ?? "";
		// ChatView renders the seed body — proves the chat view mounted.
		expect(frame).toContain("previously sent message");
		// PeerList's empty-state string is unique to that component; its
		// absence proves the peer list did not render.
		expect(frame).not.toContain("No peers found");
	});

	it("goes straight past the picker when an explicit host is given", () => {
		// The `cli <name> <port> <host>` invocation must keep working
		// unchanged — an explicit host means the user already decided.
		instance = render(<App displayName="alice" signalingPort={19001} signalingHost="127.0.0.1" />);
		expect(instance.lastFrame()).not.toContain("Select bind address");
	});
});

describe("App startup host picker", () => {
	const ESC = "";
	const ENTER = "\r";
	const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

	const spies: Array<{ mockRestore: () => void }> = [];
	let instance: ReturnType<typeof render> | null = null;

	function spyOnNetworkStarts() {
		// Both calls are the ones that actually claim a port / publish over
		// mDNS. Stubbing them keeps the test from binding anything for real.
		const listen = spyOn(PeerConnection.prototype, "startListening").mockResolvedValue(undefined);
		const publish = spyOn(DiscoveryService.prototype, "start").mockResolvedValue(undefined);
		spies.push(listen, publish);
		return { listen, publish };
	}

	afterEach(() => {
		instance?.unmount();
		instance = null;
		for (const spy of spies.splice(0)) spy.mockRestore();
	});

	it("shows the picker when no host was supplied", () => {
		spyOnNetworkStarts();
		instance = render(<App displayName="alice" signalingPort={19001} />);
		expect(instance.lastFrame()).toContain("Select bind address");
	});

	it("binds nothing while the picker is still on screen", async () => {
		// The whole point of the phase gate: an unpicked address must not
		// leak a listening socket or an mDNS advertisement.
		const { listen, publish } = spyOnNetworkStarts();
		instance = render(<App displayName="alice" signalingPort={19001} />);
		await tick();

		expect(listen).not.toHaveBeenCalled();
		expect(publish).not.toHaveBeenCalled();
	});

	it("binds the chosen address once the user confirms", async () => {
		const { listen, publish } = spyOnNetworkStarts();
		instance = render(<App displayName="alice" signalingPort={19001} />);
		const { stdin, lastFrame } = instance;
		await tick();

		stdin.write(ENTER);
		await tick();

		// The first candidate is whatever this machine enumerates first;
		// assert the wiring rather than a hard-coded address.
		expect(listen).toHaveBeenCalledTimes(1);
		expect(publish).toHaveBeenCalledTimes(1);
		const [port, bindHost] = listen.mock.calls[0];
		expect(port).toBe(19001);
		expect(typeof bindHost).toBe("string");
		// Picker is gone; the normal chat chrome has taken over.
		expect(lastFrame()).not.toContain("Select bind address");
	});

	it("advertises a concrete address when the wildcard is chosen", async () => {
		const { listen, publish } = spyOnNetworkStarts();
		instance = render(<App displayName="alice" signalingPort={19001} />);
		const { stdin } = instance;
		await tick();

		// 0.0.0.0 is always the last candidate.
		for (let i = 0; i < 20; i++) {
			stdin.write(`${ESC}[B`);
			await tick();
		}
		stdin.write(ENTER);
		await tick();

		const [, bindHost, advertiseHost] = listen.mock.calls[0];
		expect(bindHost).toBe("0.0.0.0");
		// A peer handed "0.0.0.0" would dial its own loopback, so both the
		// SDP offer and the mDNS TXT record must carry a real address.
		expect(advertiseHost).not.toBe("0.0.0.0");
		expect(publish.mock.calls[0][2]).toBe(advertiseHost);
	});
});

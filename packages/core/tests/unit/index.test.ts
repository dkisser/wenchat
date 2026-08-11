import { describe, expect, it } from "bun:test";
import {
	DiscoveryService,
	PeerConnection,
	SignalingServer,
	getLanHost,
	listBindCandidates,
	resolveAdvertiseHost,
} from "../../src/index";

describe("core index exports", () => {
	it("exports all public classes", () => {
		expect(typeof DiscoveryService).toBe("function");
		expect(typeof PeerConnection).toBe("function");
		expect(typeof SignalingServer).toBe("function");
	});

	it("exports the network helpers the CLI picker depends on", () => {
		expect(typeof getLanHost).toBe("function");
		expect(typeof listBindCandidates).toBe("function");
		expect(typeof resolveAdvertiseHost).toBe("function");
	});
});

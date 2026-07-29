import { describe, expect, it } from "bun:test";
import { DiscoveryService, PeerConnection, SignalingServer } from "./index.ts";

describe("core index exports", () => {
	it("exports all public classes", () => {
		expect(typeof DiscoveryService).toBe("function");
		expect(typeof PeerConnection).toBe("function");
		expect(typeof SignalingServer).toBe("function");
	});
});

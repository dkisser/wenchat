import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import { StatusBar } from "./StatusBar";

describe("StatusBar", () => {
	it("renders online status with peer name", () => {
		const { lastFrame } = render(<StatusBar status="online" peerName="bob" />);
		expect(lastFrame()).toContain("bob");
	});
});

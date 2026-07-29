import { render } from "ink-testing-library";
import { describe, expect, it } from "bun:test";
import { StatusBar } from "./StatusBar";

describe("StatusBar", () => {
	it("renders online status with peer name", () => {
		const { lastFrame } = render(<StatusBar status="online" peerName="bob" />);
		expect(lastFrame()).toContain("bob");
	});
});

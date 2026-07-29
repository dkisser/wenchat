import { render } from "ink-testing-library";
import { describe, expect, it } from "bun:test";
import React from "react";
import { StatusBar } from "./StatusBar.tsx";

describe("StatusBar", () => {
	it("renders online status with peer name", () => {
		const { lastFrame } = render(<StatusBar status="online" peerName="bob" />);
		expect(lastFrame()).toContain("bob");
	});
});

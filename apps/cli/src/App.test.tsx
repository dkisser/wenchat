import { render } from "ink-testing-library";
import { describe, expect, it } from "bun:test";
import React from "react";
import { App } from "./App.tsx";

describe("App", () => {
	it("renders status bar", () => {
		const { lastFrame } = render(
			<App displayName="alice" signalingPort={19001} />,
		);
		expect(lastFrame()).toContain("Offline");
	});
});

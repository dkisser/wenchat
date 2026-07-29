import { describe, expect, it } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "./App";

describe("App", () => {
	it("renders status bar", () => {
		const { lastFrame } = render(<App displayName="alice" signalingPort={19001} />);
		expect(lastFrame()).toContain("Offline");
	});
});

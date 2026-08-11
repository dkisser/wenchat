import { describe, expect, it } from "bun:test";
import type { BindCandidate } from "@wenchat/core";
import { render } from "ink-testing-library";
import { HostPicker } from "../../src/HostPicker";

const ESC = "\u001B";
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const ENTER = "\r";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const CANDIDATES: readonly BindCandidate[] = [
	{ address: "192.168.1.42", interfaceName: "en0", kind: "lan" },
	{ address: "10.0.0.5", interfaceName: "eth0", kind: "lan" },
	{ address: "127.0.0.1", interfaceName: "lo0", kind: "loopback" },
	{ address: "0.0.0.0", interfaceName: "", kind: "any" },
];

describe("HostPicker", () => {
	it("renders every candidate address with its interface name", () => {
		const { lastFrame } = render(
			<HostPicker candidates={CANDIDATES} signalingPort={0} onSelect={() => {}} />,
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("192.168.1.42");
		expect(frame).toContain("en0");
		expect(frame).toContain("10.0.0.5");
		expect(frame).toContain("eth0");
	});

	it("warns that loopback is unreachable and labels the wildcard", () => {
		const { lastFrame } = render(
			<HostPicker candidates={CANDIDATES} signalingPort={0} onSelect={() => {}} />,
		);
		const frame = lastFrame() ?? "";
		expect(frame).toContain("local only");
		expect(frame).toContain("all interfaces");
	});

	it("orders loopback and the wildcard after the LAN entries", () => {
		const { lastFrame } = render(
			<HostPicker candidates={CANDIDATES} signalingPort={0} onSelect={() => {}} />,
		);
		const frame = lastFrame() ?? "";
		expect(frame.indexOf("192.168.1.42")).toBeLessThan(frame.indexOf("127.0.0.1"));
		expect(frame.indexOf("127.0.0.1")).toBeLessThan(frame.indexOf("0.0.0.0"));
	});

	it("shows the resolved port in the heading, and 'auto' for an OS-assigned one", () => {
		const { lastFrame: withPort } = render(
			<HostPicker candidates={CANDIDATES} signalingPort={9001} onSelect={() => {}} />,
		);
		expect(withPort()).toContain("9001");

		const { lastFrame: autoPort } = render(
			<HostPicker candidates={CANDIDATES} signalingPort={0} onSelect={() => {}} />,
		);
		expect(autoPort()).toContain("auto");
	});

	it("selects the first candidate by default", () => {
		const { lastFrame } = render(
			<HostPicker candidates={CANDIDATES} signalingPort={0} onSelect={() => {}} />,
		);
		// The marker prefix only ever precedes the selected row.
		expect(lastFrame()).toContain("> 192.168.1.42");
	});

	it("never grows past the height it is given", () => {
		const many: BindCandidate[] = Array.from({ length: 50 }, (_, index) => ({
			address: `192.168.1.${index}`,
			interfaceName: `en${index}`,
			kind: "lan" as const,
		}));
		const { lastFrame } = render(
			<HostPicker candidates={many} signalingPort={0} onSelect={() => {}} height={10} />,
		);
		expect((lastFrame() ?? "").split("\n").length).toBe(10);
	});

	it("renders a fallback when there are no candidates", () => {
		const { lastFrame } = render(
			<HostPicker candidates={[]} signalingPort={0} onSelect={() => {}} />,
		);
		expect(lastFrame()).toContain("No bindable address found");
	});

	describe("keyboard navigation", () => {
		function mount() {
			const chosen: BindCandidate[] = [];
			const { stdin, lastFrame } = render(
				<HostPicker
					candidates={CANDIDATES}
					signalingPort={0}
					onSelect={(candidate) => chosen.push(candidate)}
				/>,
			);
			return { chosen, stdin, lastFrame };
		}

		it("commits the selected candidate on Enter", async () => {
			const { chosen, stdin } = mount();
			await tick();

			stdin.write(DOWN);
			await tick();
			stdin.write(ENTER);
			await tick();

			expect(chosen).toEqual([CANDIDATES[1]]);
		});

		it("moves the selection down and back up", async () => {
			const { chosen, stdin } = mount();
			await tick();

			stdin.write(DOWN);
			await tick();
			stdin.write(DOWN);
			await tick();
			stdin.write(UP);
			await tick();
			stdin.write(ENTER);
			await tick();

			expect(chosen).toEqual([CANDIDATES[1]]);
		});

		it("clamps at the top of the list", async () => {
			const { chosen, stdin } = mount();
			await tick();

			stdin.write(UP);
			await tick();
			stdin.write(UP);
			await tick();
			stdin.write(ENTER);
			await tick();

			expect(chosen).toEqual([CANDIDATES[0]]);
		});

		it("clamps at the bottom of the list", async () => {
			const { chosen, stdin } = mount();
			await tick();

			for (let i = 0; i < CANDIDATES.length + 3; i++) {
				stdin.write(DOWN);
				await tick();
			}
			stdin.write(ENTER);
			await tick();

			expect(chosen).toEqual([CANDIDATES[CANDIDATES.length - 1]]);
		});

		it("ignores Shift+Arrow, which belongs to the chat viewport", async () => {
			const { chosen, stdin } = mount();
			await tick();

			stdin.write(`${ESC}[1;2B`);
			await tick();
			stdin.write(ENTER);
			await tick();

			expect(chosen).toEqual([CANDIDATES[0]]);
		});
	});
});

import { describe, expect, it } from "bun:test";
import { formatBytes } from "../../src/formatBytes";

describe("formatBytes", () => {
	it("renders bytes below 1 KiB as-is", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(512)).toBe("512 B");
	});

	it("renders KiB/MiB/GiB with one decimal", () => {
		expect(formatBytes(65 * 1024)).toBe("65.0 KiB");
		expect(formatBytes(100 * 1024 * 1024)).toBe("100.0 MiB");
		expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 GiB");
	});
});

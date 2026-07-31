import { useStdout } from "ink";
import { useEffect, useState } from "react";

export type TerminalSize = {
	readonly rows: number;
	readonly columns: number;
};

/**
 * Used when the stream reports no size — piped output, CI logs, and ink's
 * test double all fall into this bucket. 24x80 is the classic VT100 default.
 */
export const FALLBACK_TERMINAL_SIZE: TerminalSize = { rows: 24, columns: 80 };

/**
 * Current terminal dimensions, kept in sync with SIGWINCH.
 *
 * Note the `||` rather than `??`: a non-TTY stream reports `0`, not
 * `undefined`, and a zero-height frame is worse than the fallback.
 */
export function useTerminalSize(): TerminalSize {
	const { stdout } = useStdout();
	const [size, setSize] = useState<TerminalSize>(() => readSize(stdout));

	useEffect(() => {
		const onResize = () => {
			const next = readSize(stdout);
			// Guard on equality so a spurious resize doesn't force a re-render
			// of the whole tree (and, transitively, a full re-wrap of history).
			setSize((prev) => (prev.rows === next.rows && prev.columns === next.columns ? prev : next));
		};
		onResize();
		stdout.on("resize", onResize);
		return () => {
			stdout.off("resize", onResize);
		};
	}, [stdout]);

	return size;
}

function readSize(stdout: NodeJS.WriteStream | undefined): TerminalSize {
	return {
		rows: stdout?.rows || FALLBACK_TERMINAL_SIZE.rows,
		columns: stdout?.columns || FALLBACK_TERMINAL_SIZE.columns,
	};
}

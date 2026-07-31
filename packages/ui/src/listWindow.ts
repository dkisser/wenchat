export type ListWindow = {
	readonly start: number;
	/** Exclusive. */
	readonly end: number;
};

/**
 * Pick a fixed-size slice of a list that always contains `selectedIndex`,
 * centring it when possible and sticking to either edge otherwise.
 *
 * Used to keep a bordered, fixed-height list from growing past its box: the
 * list would otherwise push the InputBox off the bottom of the screen.
 */
export function windowAround(total: number, height: number, selectedIndex: number): ListWindow {
	if (height <= 0 || total <= 0) return { start: 0, end: 0 };
	if (height >= total) return { start: 0, end: total };

	const selected = Math.min(Math.max(selectedIndex, 0), total - 1);
	const before = Math.floor((height - 1) / 2);
	const start = Math.min(Math.max(selected - before, 0), total - height);
	return { start, end: start + height };
}

/** Human-readable byte counts for transfer notices: 512 B, 63.5 KiB, 12.0 MiB. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kib = bytes / 1024;
	if (kib < 1024) return `${kib.toFixed(1)} KiB`;
	const mib = kib / 1024;
	if (mib < 1024) return `${mib.toFixed(1)} MiB`;
	return `${(mib / 1024).toFixed(1)} GiB`;
}

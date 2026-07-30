import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { reassembleFile, type FileChunkMessage, type FileStartMessage } from "@wenchat/protocol";

export const DEFAULT_DOWNLOAD_DIR = join(homedir(), "Downloads");

export type CompletedTransfer = {
	fileName: string;
	bytes: Uint8Array;
};

/**
 * State machine that consumes file-start / file-chunk messages and emits a
 * {@link CompletedTransfer} once every expected chunk has arrived. The UI
 * caller is responsible for persisting the bytes — this class is pure logic
 * with no fs dependency, which keeps it trivial to unit-test.
 *
 * Transfers are keyed by the `transferId` on the wire. A chunk arriving for
 * an unknown transfer (e.g. start was missed) is silently dropped. An
 * incomplete transfer is left in memory if the peer never finishes it; in
 * practice the connection dropping also tears down the App.
 */
export class FileReceiver {
	private transfers = new Map<
		string,
		{
			fileName: string;
			expectedChunks: number;
			chunks: Map<number, FileChunkMessage>;
		}
	>();

	onStart(start: FileStartMessage): void {
		const { transferId, fileName, fileSize, chunkSize } = start.payload;
		this.transfers.set(transferId, {
			fileName,
			// An empty file still sends one zero-byte chunk; guard against
			// fileSize === 0 → chunkSize → 0 → NaN ceilings.
			expectedChunks: Math.max(1, Math.ceil(fileSize / chunkSize)),
			chunks: new Map(),
		});
	}

	onChunk(chunk: FileChunkMessage): CompletedTransfer | null {
		const { transferId, index } = chunk.payload;
		const transfer = this.transfers.get(transferId);
		if (!transfer) return null;
		transfer.chunks.set(index, chunk);
		if (transfer.chunks.size < transfer.expectedChunks) return null;
		this.transfers.delete(transferId);
		const sorted = [...transfer.chunks.values()].sort(
			(a, b) => a.payload.index - b.payload.index,
		);
		return {
			fileName: transfer.fileName,
			bytes: reassembleFile(sorted),
		};
	}

	/** Drop any in-flight transfers (e.g. on App unmount). */
	clear(): void {
		this.transfers.clear();
	}
}

/**
 * Resolve a filename inside `downloadDir` that doesn't collide with an
 * existing file. Follows macOS Finder's " (1)", " (2)" convention: a fresh
 * `foo.md` becomes `foo.md`, then `foo (1).md`, `foo (2).md`, … if the
 * previous names are taken.
 */
export async function uniqueDownloadPath(
	downloadDir: string,
	fileName: string,
): Promise<string> {
	const safeName = basename(fileName) || `received-${Date.now()}`;
	const candidate = join(downloadDir, safeName);
	if (!(await pathExists(candidate))) return candidate;
	const ext = extname(safeName);
	const stem = safeName.slice(0, safeName.length - ext.length);
	let counter = 1;
	while (true) {
		const next = join(downloadDir, `${stem} (${counter})${ext}`);
		if (!(await pathExists(next))) return next;
		counter++;
	}
}

/**
 * Write a completed transfer to `downloadDir`, picking a non-colliding
 * name via {@link uniqueDownloadPath}. Creates the directory if missing.
 * Returns the absolute path that was written.
 */
export async function saveCompletedTransfer(
	downloadDir: string,
	transfer: CompletedTransfer,
): Promise<string> {
	await mkdir(downloadDir, { recursive: true });
	const finalPath = await uniqueDownloadPath(downloadDir, transfer.fileName);
	await writeFile(finalPath, transfer.bytes);
	return finalPath;
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}
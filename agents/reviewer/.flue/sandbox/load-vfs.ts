// Walk a real host directory tree and produce an `InitialFiles` map for
// just-bash. The map is what we hand to `new Bash({ files })` — the agent's
// entire view of the filesystem. Nothing else from the host is reachable.
//
// Decisions:
// - Text-only. Binary files (images, compiled blobs) are skipped. An LLM can't
//   review binary content meaningfully anyway, and Uint8Array handling has more
//   edge cases for our use case.
// - Symlinks are followed (fs.statSync follows by default). This matters
//   because workspace/nextjs is a symlink into .nextjs-cache/.
// - Per-file + total caps keep a pathological repo from OOM'ing the Node
//   host. Already-capped in prestage, but defence in depth.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_VFS_FILE_BYTES = 512_000;
const MAX_VFS_TOTAL_BYTES = 500_000_000; // ~500 MB sanity ceiling

interface LoadState {
	total: number;
	files: Record<string, string>;
}

/** Entry point: load the named top-level entries from hostRoot into the VFS. */
export function loadHostEntries(
	hostRoot: string,
	vfsPrefix: string,
	entryNames: string[],
): Record<string, string> {
	const state: LoadState = { total: 0, files: {} };
	for (const name of entryNames) {
		loadEntry(join(hostRoot, name), joinVfs(vfsPrefix, name), state);
	}
	const count = Object.keys(state.files).length;
	console.log(`vfs: loaded ${count} files, ${state.total} bytes from ${hostRoot}`);
	return state.files;
}

function loadEntry(hostPath: string, vfsPath: string, state: LoadState): void {
	let st;
	try {
		st = statSync(hostPath); // follows symlinks
	} catch (e: any) {
		console.warn(`vfs: skipping ${hostPath}: ${e.message}`);
		return;
	}

	if (st.isDirectory()) {
		let entries;
		try {
			entries = readdirSync(hostPath, { withFileTypes: true });
		} catch (e: any) {
			console.warn(`vfs: cannot readdir ${hostPath}: ${e.message}`);
			return;
		}
		for (const entry of entries) {
			loadEntry(join(hostPath, entry.name), joinVfs(vfsPath, entry.name), state);
		}
		return;
	}

	if (!st.isFile()) return;
	if (st.size > MAX_VFS_FILE_BYTES) return;

	let buf;
	try {
		buf = readFileSync(hostPath);
	} catch (e: any) {
		console.warn(`vfs: cannot read ${hostPath}: ${e.message}`);
		return;
	}
	if (!isProbablyText(buf)) return;

	state.files[vfsPath] = buf.toString('utf8');
	state.total += buf.length;
	if (state.total > MAX_VFS_TOTAL_BYTES) {
		throw new Error(
			`vfs: total exceeds ${MAX_VFS_TOTAL_BYTES} bytes while loading ${hostPath}`,
		);
	}
}

function joinVfs(prefix: string, name: string): string {
	if (!prefix) return '/' + name;
	return prefix + '/' + name;
}

function isProbablyText(buf: Buffer): boolean {
	if (buf.length === 0) return true;
	const sampleLen = Math.min(buf.length, 8192);
	for (let i = 0; i < sampleLen; i++) {
		if (buf[i] === 0) return false;
	}
	return true;
}

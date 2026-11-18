// Uploads that arrive in pieces (the page, the browser extension and the phone app send a file in
// chunks, each under Ledger's 1 MiB request limit). The pieces wait in temporary files under
// os.tmpdir(), one folder per upload, until the last one is in: then they are put together, the
// file is filed in Ledger's Documents (by lib/inbox.mjs) and the folder is deleted. Nothing is kept
// here: an upload that is abandoned, or left over after a restart, is swept away.

import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const CHUNK_SIZE = 512 * 1024; // bytes; base64 makes it ~700 KB, under Ledger's 1 MiB body limit
const ID = /^\d{1,18}$/;

/**
 * Temporary chunk files for one module: <tmp>/ledger-<module>-uploads/<organization>/<upload id>/<index>.part
 * root is for tests (a folder made with mkdtemp under os.tmpdir()).
 */
export function chunkStore(moduleId, root = path.join(tmpdir(), `ledger-${String(moduleId).replace(/[^a-z0-9-]/gi, "")}-uploads`)) {
	const dirOf = (org, id) => {
		if (!ID.test(String(org)) || !ID.test(String(id))) throw new Error("uploads: bad organization or upload id");
		return path.join(root, String(org), String(id));
	};
	const partOf = (dir, index) => path.join(dir, `${index}.part`);

	/** Saves one piece (a retry of the same piece replaces it). */
	async function put(org, id, index, data) {
		if (!Number.isInteger(index) || index < 0) throw new Error("uploads: bad chunk index");
		if (data.length > CHUNK_SIZE) throw new Error("uploads: chunk too large");
		const dir = dirOf(org, id);
		await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
		const tmp = path.join(dir, `.${index}.${process.pid}.${Date.now()}.tmp`);
		try {
			await fsp.writeFile(tmp, data, { mode: 0o600 });
			await fsp.rename(tmp, partOf(dir, index));
		} catch (err) {
			await fsp.rm(tmp, { force: true }).catch(() => {});
			throw err;
		}
	}

	/** The pieces that have arrived, as sorted indexes. */
	async function have(org, id) {
		const names = await fsp.readdir(dirOf(org, id)).catch(() => []);
		return names
			.map((n) => /^(\d+)\.part$/.exec(n)?.[1])
			.filter((n) => n !== undefined)
			.map(Number)
			.sort((a, b) => a - b);
	}

	/**
	 * The whole file → { data } when every piece is there and they add up to `size` bytes;
	 * else { missing: [indexes] } or { error }. Never more than `size` bytes are read.
	 */
	async function assemble(org, id, size) {
		const chunks = Math.max(1, Math.ceil(size / CHUNK_SIZE));
		const got = new Set(await have(org, id));
		const missing = [];
		for (let i = 0; i < chunks; i++) if (!got.has(i)) missing.push(i);
		if (missing.length) return { missing };
		const dir = dirOf(org, id);
		const parts = [];
		let total = 0;
		for (let i = 0; i < chunks; i++) {
			const st = await fsp.stat(partOf(dir, i));
			total += st.size;
			if (total > size) return { error: `the pieces add up to more than the ${size} bytes announced` };
			parts.push(await fsp.readFile(partOf(dir, i)));
		}
		if (total !== size) return { error: `the pieces add up to ${total} bytes, ${size} were announced` };
		return { data: Buffer.concat(parts, size) };
	}

	/** Deletes an upload's pieces (it is complete, or was given up). */
	async function discard(org, id) {
		await fsp.rm(dirOf(org, id), { recursive: true, force: true }).catch(() => {});
		// The organization's folder goes too once it is empty (rmdir refuses when it isn't).
		await fsp.rmdir(path.join(root, String(org))).catch(() => {});
	}

	/**
	 * Deletes the pieces of uploads nobody will finish: those of an organization that aren't in
	 * `keep` (the ids still uploading) and haven't been touched for `olderThanMs`. → how many.
	 */
	async function sweep(org, keep, olderThanMs = 3_600_000) {
		if (!ID.test(String(org))) return 0;
		const base = path.join(root, String(org));
		let n = 0;
		for (const e of await fsp.readdir(base, { withFileTypes: true }).catch(() => [])) {
			if (!e.isDirectory() || !ID.test(e.name) || keep.has(e.name)) continue;
			const st = await fsp.stat(path.join(base, e.name)).catch(() => null);
			if (!st || Date.now() - st.mtimeMs < olderThanMs) continue;
			await fsp.rm(path.join(base, e.name), { recursive: true, force: true }).catch(() => {});
			n++;
		}
		return n;
	}

	return { root, put, have, assemble, discard, sweep };
}

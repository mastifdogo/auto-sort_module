// lib/uploads.mjs: an upload's pieces wait in temporary files until the last one is in.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CHUNK_SIZE, chunkStore } from "../lib/uploads.mjs";

const fresh = () => chunkStore("categorizer", mkdtempSync(path.join(tmpdir(), "categorizer-test-uploads-")));
const bytes = (n, fill) => Buffer.alloc(n, fill);

test("pieces arrive in any order, a retry replaces a piece, and the file comes out whole", async () => {
	const s = fresh();
	try {
		const size = CHUNK_SIZE * 2 + 10;
		const want = Buffer.concat([bytes(CHUNK_SIZE, 1), bytes(CHUNK_SIZE, 2), bytes(10, 3)]);
		await s.put(1, 7, 2, bytes(10, 3));
		await s.put(1, 7, 0, bytes(CHUNK_SIZE, 9)); // sent wrong first
		assert.deepEqual(await s.assemble(1, 7, size), { missing: [1] });
		await Promise.all([s.put(1, 7, 1, bytes(CHUNK_SIZE, 2)), s.put(1, 7, 0, bytes(CHUNK_SIZE, 1))]); // a few at a time, as the extension does
		assert.deepEqual(await s.have(1, 7), [0, 1, 2]);
		const whole = await s.assemble(1, 7, size);
		assert.ok(whole.data.equals(want));
		// Nothing but the pieces is in the folder (no temporary names left behind).
		assert.deepEqual(readdirSync(path.join(s.root, "1", "7")).sort(), ["0.part", "1.part", "2.part"]);
		await s.discard(1, 7);
		assert.equal(existsSync(path.join(s.root, "1", "7")), false);
		assert.deepEqual(await s.assemble(1, 7, size), { missing: [0, 1, 2] });
	} finally {
		rmSync(s.root, { recursive: true, force: true });
	}
});

test("the size announced caps what is taken: pieces that don't add up to it are refused", async () => {
	const s = fresh();
	try {
		await s.put(1, 8, 0, bytes(100, 1));
		assert.match((await s.assemble(1, 8, 90)).error, /more than the 90 bytes announced/);
		assert.match((await s.assemble(1, 8, 120)).error, /add up to 100 bytes, 120 were announced/);
		await assert.rejects(s.put(1, 8, 0, bytes(CHUNK_SIZE + 1, 1)), /chunk too large/);
		await assert.rejects(s.put(1, 8, -1, bytes(1, 1)), /bad chunk index/);
		// Ids are numbers: nothing can name a path outside the upload's own folder.
		await assert.rejects(s.put(1, "../../x", 0, bytes(1, 1)), /bad organization or upload id/);
		await assert.rejects(s.put("1/..", 3, 0, bytes(1, 1)), /bad organization or upload id/);
	} finally {
		rmSync(s.root, { recursive: true, force: true });
	}
});

test("uploads live per organization, and abandoned ones are swept", async () => {
	const s = fresh();
	try {
		await s.put(1, 5, 0, bytes(4, 1));
		await s.put(2, 5, 0, bytes(4, 2)); // the same id in another organization's inbox
		assert.ok((await s.assemble(2, 5, 4)).data.equals(bytes(4, 2)));
		await s.put(1, 6, 0, bytes(4, 1));
		await s.put(1, 9, 0, bytes(4, 1));
		// 6 has no row any more and is old; 9 has no row but was touched just now; 5 is still uploading.
		const old = new Date(Date.now() - 2 * 3_600_000);
		utimesSync(path.join(s.root, "1", "6"), old, old);
		utimesSync(path.join(s.root, "1", "5"), old, old);
		assert.equal(await s.sweep(1, new Set(["5"])), 1);
		assert.deepEqual(readdirSync(path.join(s.root, "1")).sort(), ["5", "9"]);
		assert.equal(existsSync(path.join(s.root, "2", "5")), true, "another organization's uploads are left alone");
	} finally {
		rmSync(s.root, { recursive: true, force: true });
	}
});

test("the pieces are kept under the system's temporary folder, nowhere else", () => {
	assert.ok(chunkStore("categorizer").root.startsWith(tmpdir() + path.sep));
});

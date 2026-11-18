// The migrations of 0.17.0 against a real PostgreSQL (skipped without one; see test/pg.mjs): no
// binary column is left, and the one that drops file bytes refuses to run while any are there.
import assert from "node:assert/strict";
import { test } from "node:test";
import { migrationFiles, scratchDatabase } from "./pg.mjs";

test("after every migration no table has a binary (bytea) column: files are not kept in tables", async (t) => {
	const db = await scratchDatabase();
	if (!db) return t.skip("no PostgreSQL (or no Ledger checkout with the pg driver) to run this against");
	try {
		const { rows } = await db.q(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'mod_categorizer' AND data_type = 'bytea'`);
		assert.deepEqual(rows, []);
		const { rows: tables } = await db.q(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'mod_categorizer' ORDER BY 1`);
		for (const name of ["inbox_files", "inbox_extractions", "mail_seen", "mail_training", "module_state"]) assert.ok(tables.some((x) => x.table_name === name), name);
		// The path column stays until the files in the old storage have moved (a later version drops it).
		const { rows: cols } = await db.q(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'mod_categorizer' AND column_name IN ('storage_path', 'document_id') ORDER BY 1, 2`);
		assert.deepEqual(cols.map((c) => `${c.table_name}.${c.column_name}`), ["bill_documents.document_id", "bill_documents.storage_path", "inbox_files.document_id", "received_files.document_id", "statement_files.document_id", "statement_files.storage_path"]);
	} finally {
		await db.end();
	}
});

test("dropping the file bytes loses nothing: with bytes still in a table the migration stops and changes nothing", async (t) => {
	const guard = migrationFiles().find((f) => f.startsWith("020_"));
	const db = await scratchDatabase({ before: guard });
	if (!db) return t.skip("no PostgreSQL (or no Ledger checkout with the pg driver) to run this against");
	try {
		// 0.16.0's tables, with a bill whose file an older version left as bytes (not moved out yet).
		await db.q(`INSERT INTO mod_categorizer.bills (source, vendor) VALUES ('upload', 'Hydro One')`);
		await db.q(`INSERT INTO mod_categorizer.bill_documents (bill_id, file_name, content_type, content, size_bytes) VALUES (1, 'hydro.pdf', 'application/pdf', '\\x255044462d', 5)`);
		await assert.rejects(db.migrate(guard), /cannot be installed yet: 1 file\(s\) are still kept as bytes/);
		const { rows } = await db.q(`SELECT octet_length(content) AS n FROM mod_categorizer.bill_documents`);
		assert.equal(rows[0].n, 5, "the bytes are still there");
		// The installed version moves them out (to its storage) when Ledger starts; then the update goes through.
		await db.q(`UPDATE mod_categorizer.bill_documents SET content = NULL, storage_path = 'bills/1/hydro.pdf'`);
		await db.migrate(guard);
		const { rows: cols } = await db.q(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'mod_categorizer' AND table_name IN ('bill_documents', 'statement_files') AND column_name = 'content'`);
		assert.deepEqual(cols, []);
		assert.equal((await db.q(`SELECT storage_path FROM mod_categorizer.bill_documents`)).rows[0].storage_path, "bills/1/hydro.pdf", "where the file is isn't forgotten");
		for (const f of migrationFiles().filter((x) => x > guard)) await db.migrate(f);
	} finally {
		await db.end();
	}
});

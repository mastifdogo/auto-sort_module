// lib/files.mjs: every file is one of Ledger's Documents (any type); the module's old storage is
// only read from, to move what an older version left there.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { existingDocumentId, fileName, moduleFiles } from "../lib/files.mjs";
import { fakeDocuments, fakeStorage } from "./fake-ledger.mjs";

test("file names are plain, with an extension for their type", () => {
	const cases = [
		["Rogers March.pdf", "application/pdf", "Rogers March.pdf"],
		["été facture", "application/pdf", "ete facture.pdf"],
		[".hidden", "image/png", "hidden.png"],
		["../../etc/passwd", "text/plain", "etc-passwd.txt"],
		["", "text/csv", "file.csv"],
		["visa_2026.OFX", "application/x-ofx", "visa_2026.OFX"],
		["a/b\\c:d?.jpg", "image/jpeg", "a-b-c-d-.jpg"],
		["october", "text/csv; charset=utf-8", "october.csv"],
	];
	for (const [name, type, want] of cases) assert.equal(fileName(name, type), want, name);
	assert.equal(fileName("x".repeat(300), "application/pdf").length, 104);
});

test("a file Ledger already has is recognised by the document it names", () => {
	assert.equal(existingDocumentId({ status: 409, message: 'this file is already here as "Hydro" (document 12)' }), 12);
	assert.equal(existingDocumentId({ status: 409, message: "duplicate", document_id: 31 }), 31);
	assert.equal(existingDocumentId({ status: 422, message: "data must be a PDF (document 12)" }), null);
	assert.equal(existingDocumentId({ status: 409, message: "something else" }), null);
});

/** bill_documents and statement_files as arrays, answering the queries lib/files.mjs makes. */
function tables({ bills = [], statements = [], inbox = [] } = {}) {
	const T = (name) => name;
	const of = (sql) => (/bill_documents/.test(sql) ? [bills, "bill_id"] : [statements, "statement_id"]);
	const q = async (sql, params = []) => {
		if (/^INSERT INTO (bill_documents|statement_files)/.test(sql)) {
			const [rows, key] = of(sql);
			const row = { [key]: String(params[0]), file_name: params[1], content_type: params[2], size_bytes: params[3], storage_path: null, document_id: params[4] };
			const i = rows.findIndex((r) => r[key] === row[key]);
			if (i >= 0) rows[i] = row;
			else rows.push(row);
			return { rows: [], rowCount: 1 };
		}
		if (/^SELECT \(SELECT count\(\*\) FROM bill_documents WHERE document_id = \$1\)/.test(sql)) {
			const n = [...bills, ...statements, ...inbox].filter((r) => String(r.document_id) === String(params[0])).length;
			return { rows: [{ n }], rowCount: 1 };
		}
		if (/^SELECT \(SELECT count\(\*\) FROM bill_documents WHERE document_id IS NULL AND storage_path IS NOT NULL\)/.test(sql)) {
			return { rows: [{ n: [...bills, ...statements].filter((r) => r.document_id == null && r.storage_path).length }], rowCount: 1 };
		}
		if (/JOIN (bills|statements)/.test(sql)) {
			const [rows, key] = of(sql);
			const skip = params[0];
			const out = rows.filter((r) => r.document_id == null && r.storage_path && !skip.includes(r[key])).slice(0, 10).map((r) => ({ id: r[key], ...r, kind: "bill", vendor: "Hydro One", invoice_number: "", doc_date: null, vendor_entity_id: null, account_code: r.account_code ?? "1000" }));
			return { rows: out, rowCount: out.length };
		}
		if (/^UPDATE (bill_documents|statement_files) SET document_id = \$2, storage_path = NULL/.test(sql)) {
			const [rows, key] = of(sql);
			Object.assign(rows.find((r) => r[key] === String(params[0])), { document_id: params[1], storage_path: null });
			return { rows: [], rowCount: 1 };
		}
		if (/^SELECT .* FROM (bill_documents|statement_files) WHERE (bill_id|statement_id) = \$1/.test(sql)) {
			const [rows, key] = of(sql);
			const found = rows.filter((r) => r[key] === String(params[0]));
			return { rows: found, rowCount: found.length };
		}
		throw new Error(`unexpected SQL: ${sql}`);
	};
	return { q, T, bills, statements, inbox };
}
const ctxWith = (documents, storage) => ({ id: "categorizer", documents: documents.api, storage: storage.api, log: { warn() {}, info() {} } });

test("a CSV statement, an OFX file and a saved email are filed in Documents like any PDF; nothing goes to module storage", async () => {
	const documents = fakeDocuments();
	const storage = fakeStorage();
	const db = tables();
	const files = moduleFiles(ctxWith(documents, storage), db);
	const csv = Buffer.from("Date,Description,Amount\n2026-10-01,METRO,-12.00\n");
	const a = await files.saveStatementFile("1", { filename: "october.csv", contentType: "text/csv", data: csv }, { account_code: "1000" });
	assert.equal(a.added, true);
	await files.saveStatementFile("2", { filename: "visa.qfx", contentType: "application/x-ofx", data: Buffer.from("OFXHEADER:100\n<OFX></OFX>") });
	await files.saveBillFile("7", { filename: "Your bill.eml", contentType: "message/rfc822", data: Buffer.from("Subject: bill\r\n\r\nAmount due") }, { kind: "bill" });
	assert.equal(documents.docs.size, 3);
	const doc = documents.docs.get(a.document_id);
	assert.deepEqual([doc.kind, doc.filename, doc.origin, doc.account_code, doc.content_type], ["statement", "october.csv", "imported", "1000", "text/csv"]);
	assert.deepEqual(db.statements.map((r) => [r.statement_id, r.storage_path, r.document_id !== null]), [["1", null, true], ["2", null, true]]);
	assert.deepEqual(storage.calls, [], "the module's storage is never written");
	// The same bytes again: the document that has them is used, not a second copy.
	const again = await files.saveStatementFile("3", { filename: "october copy.csv", contentType: "text/csv", data: csv });
	assert.deepEqual([again.added, again.document_id], [false, a.document_id]);
	assert.equal(documents.docs.size, 3);
	// Read back from Documents, with the address a browser opens it at.
	const back = await files.readStatementFile("1");
	assert.ok(back.data.equals(csv));
	assert.equal(back.url, `/api/v1/documents/${a.document_id}/file`);
});

test("a file that is a document already (from the inbox, or handed over) keeps its id: nothing is filed again", async () => {
	const documents = fakeDocuments();
	const db = tables();
	const files = moduleFiles(ctxWith(documents, fakeStorage()), db);
	const id = documents.put({ kind: "other", filename: "scan.pdf", data: Buffer.from("%PDF-1.4 scan") });
	const r = await files.saveBillFile("9", { filename: "scan.pdf", contentType: "application/pdf", size: 13, documentId: id }, { kind: "receipt" });
	assert.deepEqual(r, { document_id: id, added: false });
	assert.deepEqual(documents.calls.filter((c) => c[0] === "add"), []);
	assert.equal(await files.billDocumentId("9"), id);
});

test("what an older version left in the module's storage moves to Documents: once, quietly, and safely again", async () => {
	const documents = fakeDocuments();
	const storage = fakeStorage({ "statements/4/march.csv": Buffer.from("Date,Amount\n2026-03-01,-5.00\n"), "bills/2/photo.gif": Buffer.from("GIF89a....") });
	const db = tables({
		statements: [{ statement_id: "4", file_name: "march.csv", content_type: "text/csv", storage_path: "statements/4/march.csv", document_id: null }, { statement_id: "5", file_name: "lost.ofx", content_type: "application/x-ofx", storage_path: "statements/5/lost.ofx", document_id: null }],
		bills: [{ bill_id: "2", file_name: "photo.gif", content_type: "image/gif", storage_path: "bills/2/photo.gif", document_id: null }],
	});
	const files = moduleFiles(ctxWith(documents, storage), db);
	assert.equal(await files.pendingInStorage(), 3);
	const r = await files.moveStorageToDocuments();
	assert.deepEqual(r, { moved: 2, missing: 1 });
	assert.equal(storage.stored.size, 0, "moved files are taken out of the storage");
	assert.equal(db.statements[0].storage_path, null);
	assert.ok(db.statements[0].document_id);
	assert.equal(documents.docs.get(Number(db.statements[0].document_id)).account_code, "1000");
	// A file that can't be found stays as it is, to be looked for again.
	assert.equal(db.statements[1].storage_path, "statements/5/lost.ofx");
	// Moved, not new: other modules aren't told (announce: false).
	assert.ok(documents.calls.filter((c) => c[0] === "add").every((c) => c[2]?.announce === false));
	assert.deepEqual(storage.calls.filter((c) => c[0] === "put"), []);
	assert.deepEqual(await files.moveStorageToDocuments(), { moved: 0, missing: 1 });
	assert.equal(documents.docs.size, 2);
});

test("a document goes with its bill or statement only when this module filed it and nothing else here uses it", async () => {
	const documents = fakeDocuments();
	const db = tables();
	const files = moduleFiles(ctxWith(documents, fakeStorage()), db);
	const own = await files.saveBillFile("1", { filename: "a.pdf", contentType: "application/pdf", data: Buffer.from("%PDF-1.4 a") }, { kind: "bill" });
	await files.removeBillFile("1");
	assert.equal(documents.docs.has(own.document_id), false);
	// Used by an inbox file too: it stays.
	const shared = await files.saveBillFile("2", { filename: "b.pdf", contentType: "application/pdf", data: Buffer.from("%PDF-1.4 b") }, { kind: "bill" });
	db.inbox.push({ document_id: shared.document_id });
	await files.removeBillFile("2");
	assert.equal(documents.docs.has(shared.document_id), true);
	// Filed by a person: Ledger refuses, and it stays.
	const theirs = documents.put({ kind: "invoice", filename: "c.pdf", data: Buffer.from("%PDF-1.4 c") });
	await files.saveBillFile("3", { filename: "c.pdf", contentType: "application/pdf", size: 10, documentId: theirs });
	await files.removeBillFile("3");
	assert.equal(documents.docs.has(theirs), true);
});

test("no code path saves a file itself: no storage put, no binary column after the migrations, no disk writes outside os.tmpdir()", () => {
	const dir = new URL("../lib/", import.meta.url);
	const sources = [new URL("../server.mjs", import.meta.url), ...readdirSync(dir).filter((f) => f.endsWith(".mjs")).map((f) => new URL(f, dir))];
	for (const file of sources) {
		const code = readFileSync(file, "utf8");
		assert.doesNotMatch(code, /\bstorage\s*\.\s*put\s*\(/, `${file.pathname} writes to the module's storage`);
		if (/\bfsp?\s*\.\s*(writeFile|appendFile|createWriteStream|copyFile|rename)\b/.test(code)) assert.match(code, /tmpdir\s*\(/, `${file.pathname} writes files outside os.tmpdir()`);
	}
	// Every bytea column a migration made is dropped by a later one.
	const mdir = new URL("../migrations/", import.meta.url);
	const blobs = new Set();
	for (const f of readdirSync(mdir).sort()) {
		const sql = readFileSync(new URL(f, mdir), "utf8").replace(/--.*$/gm, "");
		for (const m of sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) for (const c of m[2].matchAll(/^\s*(\w+)\s+bytea\b/gim)) blobs.add(`${m[1]}.${c[1]}`);
		for (const m of sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+) bytea\b/gi)) blobs.add(`${m[1]}.${m[2]}`);
		for (const m of sql.matchAll(/ALTER TABLE (\w+) DROP COLUMN (\w+)/gi)) blobs.delete(`${m[1]}.${m[2]}`);
	}
	assert.deepEqual([...blobs], []);
});

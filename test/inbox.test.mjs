// The inbox's routes (lib/inbox.mjs) and the statement and bill routes they lead to, against a
// stand-in Ledger: files go to Documents (never to module storage or into SQL), a file is read
// once, and the AI's reading is kept only after a person approved it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHUNK_SIZE } from "../lib/uploads.mjs";
import { fakeDocuments, fakeStorage, start } from "./fake-ledger.mjs";

const ACCOUNTS = [
	{ code: "1000", name: "Chequing", type: "asset", currency: "CAD", is_active: true },
	{ code: "2100", name: "Visa", type: "liability", currency: "CAD", is_active: true },
	{ code: "5100", name: "Utilities", type: "expense", currency: "CAD", is_active: true },
];
const FILE = { id: 5n, name: "october.csv", content_type: "text/csv", size_bytes: 0n, status: "new", source_url: "", note: "", origin: "upload", origin_detail: "", account_code: "", document_id: null, document_added_here: false, sent_at: null, mail_uid: "", mail_folder: "" };

/** The inbox_files table as one row (the file under test), plus what staging a statement inserts. */
function inboxDb(file, extra = []) {
	const state = { file, statements: [], transactions: [], extraction: null, bills: [] };
	const answers = [
		...extra,
		[/^INSERT INTO mod_categorizer\.inbox_files \(name, content_type, size_bytes, source_url/, (_s, p) => {
			Object.assign(state.file, { name: p[0], content_type: p[1], size_bytes: BigInt(p[2]), source_url: p[3], origin: p[5], note: p[6], account_code: p[7], origin_detail: p[8], status: "uploading" });
			return [{ id: state.file.id }];
		}],
		[/^SELECT id, name, content_type[\s\S]*FROM mod_categorizer\.inbox_files WHERE id = \$1/, () => [{ ...state.file }]],
		[/^UPDATE mod_categorizer\.inbox_files SET status = 'new', sha256 = \$2, document_id = \$3/, (_s, p) => {
			if (state.file.status !== "uploading") return { rows: [], rowCount: 0 };
			Object.assign(state.file, { status: "new", sha256: p[1], document_id: p[2], document_added_here: p[3] });
			return { rows: [], rowCount: 1 };
		}],
		[/^UPDATE mod_categorizer\.inbox_files SET status = 'sent'/, (_s, p) => {
			Object.assign(state.file, { status: "sent", sent_to: p[1], sent_link: p[2], sent_by: p[3], sent_at: new Date(), statement_id: p[5] ?? state.file.statement_id, bill_id: p[6] ?? state.file.bill_id });
			return { rows: [], rowCount: 1 };
		}],
		[/^INSERT INTO mod_categorizer\.statements/, (_s, p) => (state.statements.push({ id: 41n, filename: p[0], account_code: p[1], format: p[2], ai_reading: p[12] }), [{ id: 41n }])],
		[/^INSERT INTO mod_categorizer\.statement_files/, (_s, p) => void (state.statement_file = { statement_id: p[0], document_id: p[4] })],
		[/^INSERT INTO mod_categorizer\.transactions/, (_s, p) => {
			state.transactions = p[2].map((line, i) => ({ line, date: p[4][i], description: p[5][i], amount: p[7][i], fitid: p[8][i] }));
			return { rows: [], rowCount: p[2].length };
		}],
		[/^INSERT INTO mod_categorizer\.inbox_extractions/, (_s, p) => (state.extraction = { id: 8n, file_id: p[0], status: "pending", currency: p[2], rows: JSON.parse(p[4]) }, [{ id: 8n }])],
		[/FROM mod_categorizer\.inbox_extractions e JOIN mod_categorizer\.inbox_files f ON f\.id = e\.file_id WHERE e\.id = \$1/, () => (state.extraction ? [{ ...state.extraction, file_name: state.file.name, document_id: state.file.document_id }] : [])],
		[/^UPDATE mod_categorizer\.inbox_extractions SET status = 'approved'/, (_s, p) => {
			if (state.extraction.status !== "pending") return { rows: [], rowCount: 0 };
			Object.assign(state.extraction, { status: "approved", decided_by: p[1], rows: JSON.parse(p[2]) });
			return { rows: [], rowCount: 1 };
		}],
	];
	return { state, answers };
}
const b64 = (buf) => buf.toString("base64");
const noBytesInSql = (L) => assert.ok(!L.sql.some((s) => s.params.some((p) => Buffer.isBuffer(p) || p instanceof Uint8Array)), "no file bytes go into the module's tables");

test("an upload in pieces becomes a document in Ledger; the inbox keeps only its id", async () => {
	const { state, answers } = inboxDb({ ...FILE });
	const L = await start({ answers });
	const data = Buffer.concat([Buffer.alloc(CHUNK_SIZE, "a"), Buffer.from("Date,Description,Amount\n2026-10-01,METRO,-12.00\n")]);
	const r = await L.call("POST /inbox", { body: { name: "big statement.csv", content_type: "text/csv", size: data.length, origin: "upload" } });
	assert.deepEqual([r.status, r.body.chunk_size, r.body.chunks], [201, CHUNK_SIZE, 2]);
	// The last piece first; a piece of the wrong size is refused; completing early says what is missing.
	await L.call("PUT /inbox/:id/chunks/:index", { params: { id: "5", index: "1" }, body: { data: b64(data.subarray(CHUNK_SIZE)) } });
	await assert.rejects(L.call("PUT /inbox/:id/chunks/:index", { params: { id: "5", index: "0" }, body: { data: b64(Buffer.from("short")) } }), { status: 422 });
	await assert.rejects(L.call("PUT /inbox/:id/chunks/:index", { params: { id: "5", index: "2" }, body: { data: "" } }), { status: 422 });
	await assert.rejects(L.call("POST /inbox/:id/complete", { params: { id: "5" } }), (e) => e.status === 409 && /chunks missing: 0/.test(e.message));
	assert.equal(L.documents.docs.size, 0, "nothing is filed before the upload is complete");
	await L.call("PUT /inbox/:id/chunks/:index", { params: { id: "5", index: "0" }, body: { data: b64(data.subarray(0, CHUNK_SIZE)) } });
	const done = await L.call("POST /inbox/:id/complete", { params: { id: "5" } });
	assert.equal(done.status, "new");
	const doc = L.documents.docs.get(Number(state.file.document_id));
	assert.ok(doc.data.equals(data));
	assert.deepEqual([doc.filename, doc.kind, doc.origin, doc.content_type], ["big statement.csv", "other", "imported", "text/csv"]);
	assert.equal(done.url, `/api/v1/documents/${doc.id}/file`);
	assert.equal(state.file.document_added_here, true);
	assert.deepEqual(L.storage.calls, [], "nothing goes to the module's storage");
	noBytesInSql(L);
	// Completing again changes nothing; a piece sent after that is refused.
	assert.equal((await L.call("POST /inbox/:id/complete", { params: { id: "5" } })).status, "new");
	await assert.rejects(L.call("PUT /inbox/:id/chunks/:index", { params: { id: "5", index: "0" }, body: { data: "" } }), { status: 409 });
	assert.equal(L.documents.docs.size, 1);
	// A receipt photographed on a phone is filed as a receipt.
	const cam = inboxDb({ ...FILE });
	const C = await start({ answers: cam.answers });
	const pdf = Buffer.from("%PDF-1.4 a receipt");
	await C.call("POST /inbox", { body: { name: "Receipt.pdf", content_type: "application/pdf", size: pdf.length, origin: "camera", note: "lunch" } });
	await C.call("PUT /inbox/:id/chunks/:index", { params: { id: "5", index: "0" }, body: { data: b64(pdf) } });
	await C.call("POST /inbox/:id/complete", { params: { id: "5" } });
	assert.equal(C.documents.docs.get(Number(cam.state.file.document_id)).kind, "receipt");
});

test("POST /inbox validates every field", async () => {
	const { answers } = inboxDb({ ...FILE });
	const L = await start({ answers, settings: { max_file_mb: 1 } });
	const ok = { name: "a.csv", size: 10 };
	for (const body of [{}, { ...ok, name: "a/b.csv" }, { ...ok, name: "" }, { ...ok, size: 0 }, { ...ok, size: "ten" }, { ...ok, origin: "email" }, { ...ok, note: 5 }, { ...ok, account_code: "10 00" }, { ...ok, content_type: 7 }, { ...ok, source_url: {} }]) {
		await assert.rejects(L.call("POST /inbox", { body }), { status: 422 }, JSON.stringify(body));
	}
	await assert.rejects(L.call("POST /inbox", { body: { ...ok, size: 2 << 20 } }), { status: 413 });
	await assert.rejects(L.call("POST /inbox", { body: undefined }), { status: 422 });
	assert.equal((await L.call("POST /inbox", { body: ok })).status, 201);
});

test("a CSV in the inbox becomes a statement: parsed once, its lines kept with the document, and used from there after", async () => {
	const documents = fakeDocuments();
	const csv = Buffer.from("Date,Description,Amount\n2026-10-01,METRO GROCERY,-45.10\n2026-10-03,PAYROLL,2500.00\n");
	const docId = documents.put({ kind: "other", filename: "october.csv", data: csv, source: "categorizer" });
	const { state, answers } = inboxDb({ ...FILE, size_bytes: BigInt(csv.length), document_id: docId, document_added_here: true });
	const L = await start({ answers, documents, ledger: { listAccounts: async () => ACCOUNTS } });
	for (const body of [{}, { account_code: "1000", flip_signs: "yes" }, { account_code: "1000", date_order: "ymd" }, { account_code: "9999" }, { account_code: "5100" }]) {
		await assert.rejects(L.call("POST /inbox/:id/statement", { params: { id: "5" }, body }), { status: 422 }, JSON.stringify(body));
	}
	const r = await L.call("POST /inbox/:id/statement", { params: { id: "5" }, body: { account_code: "1000" } });
	assert.deepEqual({ id: r.statement.id, n: r.statement.transactions, from: r.statement.from_extraction }, { id: 41n, n: 2, from: false });
	assert.equal(r.status, "sent");
	assert.equal(state.file.sent_link, "/apps/categorizer?statement=41");
	assert.equal(state.file.statement_id, 41n);
	// No copy: the statement points at the same document, now filed as that account's statement.
	assert.equal(Number(state.statement_file.document_id), docId);
	assert.deepEqual([documents.docs.get(docId).kind, documents.docs.get(docId).account_code], ["statement", "1000"]);
	assert.equal(documents.docs.size, 1);
	// What the parser read is kept with the document straight away, under the shared keys.
	const x = documents.extractions.get(docId).data;
	assert.equal(x.type, "statement");
	assert.deepEqual(x.transactions, [{ date: "2026-10-01", description: "METRO GROCERY", amount_cents: -4510 }, { date: "2026-10-03", description: "PAYROLL", amount_cents: 250000 }]);
	assert.equal(x.categorizer.format, "csv");
	assert.ok(documents.tags.get(docId).some((t) => t.tag === "extracted"));
	// Read once: with the file's bytes gone bad, staging again still works, from what was kept.
	documents.docs.get(docId).data = Buffer.from("this is no longer a statement");
	const again = await L.call("POST /inbox/:id/statement", { params: { id: "5" }, body: { account_code: "2100", flip_signs: true } });
	assert.equal(again.statement.from_extraction, true);
	assert.deepEqual(state.transactions.map((t) => [t.date, t.description, t.amount]), [["2026-10-01", "METRO GROCERY", "4510"], ["2026-10-03", "PAYROLL", "-250000"]]);
	// The person said this card's file has its signs the other way round: what is kept now says so.
	assert.equal(documents.extractions.get(docId).data.categorizer.flipped, true);
	assert.deepEqual(L.storage.calls, []);
	noBytesInSql(L);
});

test("a PDF statement: nothing until its data is read; the AI's reading is kept only once a person approves it; then it is staged from that", async () => {
	const documents = fakeDocuments();
	const pdf = Buffer.from("%PDF-1.4 a bank statement");
	const docId = documents.put({ kind: "other", filename: "statement.pdf", data: pdf, source: "categorizer" });
	const { state, answers } = inboxDb({ ...FILE, name: "statement.pdf", content_type: "application/pdf", size_bytes: BigInt(pdf.length), document_id: docId });
	let asked = 0;
	const L = await start({
		answers, documents, ledger: { listAccounts: async () => ACCOUNTS },
		llm: {
			status: async () => ({ configured: true, allowed: true, readsPdf: true, images: { configured: true } }),
			json: async (req) => {
				asked++;
				assert.equal(req.documents[0].media_type, "application/pdf");
				return { model: "some-model", data: { currency: "CAD", transactions: [{ date: "2026-10-01", description: "METRO", amount: "-45.10", balance: "954.90" }, { date: "2026-10-02", description: "not a date really", amount: "x", balance: "" }, { date: "2026-10-05", description: "RENT", amount: "-1,200.00", balance: "" }] } };
			},
		},
	});
	await assert.rejects(L.call("POST /inbox/:id/statement", { params: { id: "5" }, body: { account_code: "1000" } }), (e) => e.status === 409 && /Extract data first/.test(e.message));
	const ex = await L.call("POST /inbox/:id/extract", { params: { id: "5" }, body: {} });
	assert.equal(ex.status, 201);
	assert.equal(ex.body.rows.length, 2, "rows the AI got wrong are left out");
	assert.equal(ex.body.model, undefined, "the page isn't told which model read it");
	// Only a suggestion so far: nothing is kept with the document.
	assert.equal(documents.extractions.has(docId), false);
	assert.equal(state.file.status, "new");
	// The person corrects a row and approves.
	await assert.rejects(L.call("POST /extractions/:id/approve", { params: { id: "8" }, body: { rows: [{ date: "2026-13-01", description: "x", amount: "1" }] } }), { status: 422 });
	await assert.rejects(L.call("POST /extractions/:id/approve", { params: { id: "8" }, body: { rows: [] } }), { status: 422 });
	const rows = [{ date: "2026-10-01", description: "METRO GROCERY", amount: "-45.10", balance: "954.90" }, { date: "2026-10-05", description: "RENT", amount: "-1200.00", balance: "" }];
	const ok = await L.call("POST /extractions/:id/approve", { params: { id: "8" }, body: { rows } }, );
	assert.equal(ok.transactions, 2);
	const x = documents.extractions.get(docId).data;
	assert.equal(x.type, "transactions");
	assert.deepEqual(x.transactions[0], { date: "2026-10-01", description: "METRO GROCERY", amount_cents: -4510, balance_cents: 95490 });
	assert.equal(x.categorizer.approved_by, "pat");
	// Approving twice is refused; no CSV was minted: there is still one document.
	await assert.rejects(L.call("POST /extractions/:id/approve", { params: { id: "8" }, body: {} }), { status: 409 });
	assert.equal(documents.docs.size, 1);
	// Now it stages straight from the approved transactions, and the AI isn't asked again.
	const r = await L.call("POST /inbox/:id/statement", { params: { id: "5" }, body: { account_code: "1000" } });
	assert.equal(r.statement.from_extraction, true);
	assert.deepEqual(state.transactions.map((t) => t.amount), ["-4510", "-120000"]);
	await assert.rejects(L.call("POST /inbox/:id/extract", { params: { id: "5" }, body: {} }), (e) => e.status === 409 && /already read/.test(e.message));
	assert.equal(asked, 1);
	// The page gets the kept transactions as rows (for a CSV made in the browser).
	const t = await L.call("GET /inbox/:id/transactions", { params: { id: "5" } });
	assert.deepEqual(t.rows[1], { date: "2026-10-05", description: "RENT", amount: "-1200.00", balance: "" });
});

/** A bills table of one row, answering what approving and re-reading a bill asks. */
function billDb(bill) {
	const inserted = [];
	return {
		inserted, bill,
		answers: [
			[/^INSERT INTO mod_categorizer\.bills \(kind, vendor, invoice_number/, (_s, p) => {
				inserted.push(p);
				Object.assign(bill, { id: 7n, kind: p[0], vendor: p[1], invoice_number: p[2], bill_date: p[3], due_date: p[4], amount_cents: p[5] === null ? null : BigInt(p[5]), currency: p[6], account_code: p[7], confidence: p[8], summary: p[9], status: "new", source: p[11], journal_entry_id: null, paid_entry_id: null, vendor_entity_id: null });
				return [{ id: 7n }];
			}],
			[/^INSERT INTO mod_categorizer\.bill_documents/, (_s, p) => void (bill.document_id = p[4])],
			[/FROM mod_categorizer\.bills b LEFT JOIN mod_categorizer\.bill_documents d ON d\.bill_id = b\.id WHERE b\.id = \$1/, () => (bill.id ? [{ ...bill, has_document: bill.document_id != null }] : [])],
			[/^UPDATE mod_categorizer\.bills SET status = \$2, error = \$3/, (_s, p) => void (bill.status = p[1])],
			[/^SELECT document_id FROM mod_categorizer\.bill_documents WHERE bill_id = \$1 AND document_id IS NOT NULL\s+UNION/, () => (bill.document_id != null ? [{ document_id: bill.document_id }] : [])],
			[/^SELECT document_id FROM mod_categorizer\.bill_documents WHERE bill_id = \$1/, () => (bill.document_id != null ? [{ document_id: bill.document_id }] : [])],
		],
	};
}

test("a bill is read by the AI once: approving it keeps what it says with the document, and the same file is never sent to the AI again", async () => {
	const documents = fakeDocuments();
	const pdf = Buffer.from("%PDF-1.4 hydro one bill for october");
	const db = billDb({});
	let asked = 0;
	const llm = {
		status: async () => ({ configured: true, allowed: true, readsPdf: true, images: { configured: true } }),
		json: async () => (asked++, { data: { kind: "bill", vendor: "Hydro One", invoice_number: "INV-9", bill_date: "2026-10-01", due_date: "2026-10-20", amount_due: "85.50", currency: "CAD", account_code: "5100", confidence: 0.9, summary: "October power", items: [] } }),
	};
	const L = await start({ answers: db.answers, documents, llm, ledger: { listAccounts: async () => ACCOUNTS } });
	for (const body of [{}, { filename: "x.pdf", content_base64: "" }, { filename: "x.pdf", content_base64: "not base64!" }, { filename: "x.pdf", content_base64: 5 }]) {
		await assert.rejects(L.call("POST /bills/upload", { body }), { status: 422 }, JSON.stringify(body));
	}
	const r = await L.call("POST /bills/upload", { body: { filename: "hydro.pdf", content_base64: pdf.toString("base64") } });
	assert.equal(r.status, 201);
	assert.equal(asked, 1);
	const docId = Number(db.bill.document_id);
	assert.deepEqual([documents.docs.get(docId).kind, documents.docs.get(docId).filename], ["invoice", "hydro.pdf"]);
	// What the AI read is only the module's suggestion until a person approves the bill.
	assert.equal(documents.extractions.has(docId), false);
	await L.call("POST /bills/:id/approve", { params: { id: "7" } });
	assert.equal(db.bill.status, "open");
	const x = documents.extractions.get(docId).data;
	assert.deepEqual({ type: x.type, vendor: x.vendor, number: x.number, date: x.date, due_date: x.due_date, total_cents: x.total_cents, currency: x.currency }, { type: "bill", vendor: "Hydro One", number: "INV-9", date: "2026-10-01", due_date: "2026-10-20", total_cents: 8550, currency: "CAD" });
	assert.deepEqual(L.storage.calls, []);
	noBytesInSql(L);

	// The same file arrives again (in another organization's module, after a restore, from another
	// module): it is made a bill from what Ledger keeps, and the AI isn't asked.
	const db2 = billDb({});
	const L2 = await start({ answers: db2.answers, documents, llm: { ...llm, json: async () => { throw new Error("the AI must not be asked again"); } }, ledger: { listAccounts: async () => ACCOUNTS } });
	const again = await L2.call("POST /bills/upload", { body: { filename: "hydro again.pdf", content_base64: pdf.toString("base64") } });
	assert.equal(again.status, 201);
	assert.deepEqual(db2.inserted[0].slice(0, 7), ["bill", "Hydro One", "INV-9", "2026-10-01", "2026-10-20", "8550", "CAD"]);
	assert.equal(Number(db2.bill.document_id), docId, "the document that has the file is used, not a second copy");
	assert.equal(documents.docs.size, 1);
	assert.equal(asked, 1);
});

test("a file another module read is used as it is: a receipt with its data comes in without any AI set up", async () => {
	const documents = fakeDocuments();
	const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);
	const docId = documents.put({ kind: "receipt", filename: "cafe.jpg", data: jpg, source: "scanner-mod" });
	await documents.api.setExtracted(docId, { data: { type: "receipt", vendor: "Corner Cafe", date: "2026-11-02", total_cents: 1450, currency: "CAD", items: [{ description: "Lunch", quantity: 1, rate_cents: 1450, amount_cents: 1450 }] } });
	const db = billDb({});
	const { state, answers } = inboxDb({ ...FILE, name: "cafe.jpg", content_type: "image/jpeg", size_bytes: BigInt(jpg.length), document_id: docId, origin: "app", account_code: "5100" }, db.answers);
	const L = await start({ answers, documents, ledger: { listAccounts: async () => ACCOUNTS } }); // llm: not set up
	await assert.rejects(L.call("POST /inbox/:id/bill", { params: { id: "5" }, body: { kind: "invoice" } }), { status: 422 });
	const r = await L.call("POST /inbox/:id/bill", { params: { id: "5" }, body: { kind: "receipt" } });
	assert.deepEqual({ id: r.bill.id, read: r.bill.read, vendor: r.bill.vendor }, { id: 7n, read: "extracted", vendor: "Corner Cafe" });
	assert.deepEqual(db.inserted[0].slice(0, 7), ["receipt", "Corner Cafe", "", "2026-11-02", null, "1450", "CAD"]);
	assert.equal(state.file.status, "sent");
	assert.equal(state.file.sent_link, "/apps/categorizer?bill=7");
	assert.equal(Number(db.bill.document_id), docId);
	// The account the person chose on the phone is theirs, not a guess.
	assert.ok(L.sql.some((s) => /^UPDATE mod_categorizer\.bills SET account_code = \$2/.test(s.text) && s.params[1] === "5100"));
	// A document someone else filed is never removed by the module, and nothing was filed twice.
	assert.equal(documents.docs.size, 1);
	assert.ok(!documents.calls.some((c) => c[0] === "remove"));
});

test("deleting an inbox file removes its document only when the inbox added it and it was never sent on", async () => {
	const run = async (file, setup = () => {}) => {
		const documents = fakeDocuments();
		const docId = documents.put({ kind: "other", filename: "x.pdf", data: Buffer.from("%PDF-1.4 x"), source: file.source ?? "categorizer" });
		const { answers } = inboxDb({ ...FILE, name: "x.pdf", document_id: docId, ...file });
		const uses = { n: 0 };
		setup(uses);
		const L = await start({ documents, answers: [[/^SELECT \(SELECT count\(\*\) FROM mod_categorizer\.bill_documents WHERE document_id = \$1\)/, () => [{ n: uses.n }]], ...answers] });
		assert.deepEqual(await L.call("DELETE /inbox/:id", { params: { id: "5" } }), { deleted: true, learned: false });
		return documents.docs.has(docId);
	};
	assert.equal(await run({ document_added_here: true }), false, "added here, never sent: the document goes too");
	assert.equal(await run({ document_added_here: true, sent_at: new Date(), status: "sent" }), true, "sent on: it is one of the organization's documents");
	assert.equal(await run({ document_added_here: false }), true, "it was there before");
	assert.equal(await run({ document_added_here: true }, (u) => (u.n = 1)), true, "a bill or statement here still uses it");
});

test("handing a file to another module sends the document it is, not a copy", async () => {
	const documents = fakeDocuments();
	const docId = documents.put({ kind: "other", filename: "customers.csv", data: Buffer.from("name\nAcme\n"), source: "categorizer" });
	const { state, answers } = inboxDb({ ...FILE, name: "customers.csv", document_id: docId });
	const sent = [];
	const L = await start({ answers, documents, files: { targets: (kind) => [{ id: "sales", name: "Sales", version: "1.0.0", accepts: ["customer"] }, { id: "categorizer", name: "Auto sort", accepts: ["statement"] }].filter((t) => !kind || t.accepts.includes(kind)), send: async (f) => (sent.push(f), { id: 77, status: "new", result: "" }) } });
	assert.deepEqual((await L.call("GET /targets")).data.map((t) => t.id), ["sales"], "the module doesn't offer itself");
	for (const body of [{}, { to: "categorizer", kind: "statement" }, { to: "sales", kind: "nope" }, { to: "sales", kind: "customer", account_code: "bad code" }, { to: "sales", kind: "customer", note: 3 }]) {
		await assert.rejects(L.call("POST /inbox/:id/handoff", { params: { id: "5" }, body }), { status: 422 }, JSON.stringify(body));
	}
	await assert.rejects(L.call("POST /inbox/:id/handoff", { params: { id: "5" }, body: { to: "sales", kind: "vendor" } }), { status: 409 });
	const r = await L.call("POST /inbox/:id/handoff", { params: { id: "5" }, body: { to: "sales", kind: "customer" } });
	assert.equal(r.status, "sent");
	assert.deepEqual({ to: sent[0].to, kind: sent[0].kind, document_id: sent[0].document_id, data: sent[0].data }, { to: "sales", kind: "customer", document_id: docId, data: undefined });
	assert.equal(state.file.sent_to, "Sales (customer)");
});

test("a file another module hands over is the document it names: its id is kept, and what was read out of it is used", async () => {
	const documents = fakeDocuments();
	// The sender filed a PDF statement and read its transactions (its own AI, its own approval).
	const pdf = Buffer.from("%PDF-1.4 a statement another module read");
	const docId = documents.put({ kind: "statement", filename: "visa.pdf", data: pdf, source: "bank-sync" });
	await documents.api.setExtracted(docId, { data: { type: "statement", currency: "CAD", transactions: [{ date: "2026-10-04", description: "BOOKSTORE", amount_cents: -3100 }, { date: "2026-10-06", description: "PAYMENT RECEIVED", amount_cents: 20000 }] } });
	const { state, answers } = inboxDb({ ...FILE });
	let listener;
	const updates = [];
	const received = [];
	const L = await start({
		answers: [[/^INSERT INTO mod_categorizer\.received_files/, (_s, p) => void received.push(p)], ...answers],
		documents,
		ledger: { listAccounts: async () => ACCOUNTS },
		llm: { status: async () => ({ configured: true, allowed: true, readsPdf: true, images: { configured: true } }), json: async () => { throw new Error("the AI must not be asked: the document's data was read already"); } },
		files: {
			onReceive: (fn) => (listener = fn),
			get: async (id) => ({ id, sender: "bank-sync", recipient: "categorizer", kind: "statement", filename: "visa.pdf", content_type: "application/pdf", status: "new", document_id: docId, meta: { account_code: "2100" }, note: "", sent_by: "pat", data: pdf }),
			update: async (id, change) => void updates.push(change),
		},
	});
	listener({ id: 9 });
	for (let i = 0; i < 50 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
	assert.equal(received.length, 1);
	assert.deepEqual([received[0][1], received[0][5], received[0][6]], ["statement", false, String(docId)], "staged, not waiting on the AI, and the document's id is kept");
	assert.deepEqual(state.transactions.map((t) => [t.description, t.amount]), [["BOOKSTORE", "-3100"], ["PAYMENT RECEIVED", "20000"]]);
	assert.equal(Number(state.statement_file.document_id), docId);
	assert.equal(updates.at(-1).status, "done");
	// No copy was filed, and the sender's document wasn't touched but for saying whose statement it is.
	assert.equal(documents.docs.size, 1);
	assert.ok(!documents.calls.some((c) => c[0] === "add" || c[0] === "remove"));
	assert.deepEqual(L.storage.calls, []);
});

// lib/doc-tags.mjs: Ledger's tags on files follow the module's bills and statements, and the
// module follows what a person or another module tags.
import assert from "node:assert/strict";
import { test } from "node:test";
import { billDocumentTags, documentTags, statementDocumentTags } from "../lib/doc-tags.mjs";
import { fakeDocuments } from "./fake-ledger.mjs";

test("what a bill's document says: posted with its entry, paid, overdue", () => {
	const now = "2026-11-18";
	assert.deepEqual(billDocumentTags({ kind: "bill", status: "new", due_date: "2026-11-01", journal_entry_id: null, paid_entry_id: null }, now), { posted: null, paid: false, overdue: false });
	assert.deepEqual(billDocumentTags({ kind: "bill", status: "open", due_date: "2026-11-01", journal_entry_id: 12n, paid_entry_id: null }, now), { posted: "entry 12", paid: false, overdue: true });
	assert.deepEqual(billDocumentTags({ kind: "bill", status: "open", due_date: "2026-12-01", journal_entry_id: null, paid_entry_id: null }, now), { posted: null, paid: false, overdue: false });
	assert.deepEqual(billDocumentTags({ kind: "bill", status: "paid", due_date: "2026-11-01", journal_entry_id: 12n, paid_entry_id: 15n }, now), { posted: "entry 12, paid by entry 15", paid: true, overdue: false });
	assert.deepEqual(billDocumentTags({ kind: "receipt", status: "paid", due_date: null, journal_entry_id: null, paid_entry_id: 20n }, now), { posted: "entry 20", paid: true, overdue: false });
	// A receipt is never overdue.
	assert.equal(billDocumentTags({ kind: "receipt", status: "open", due_date: "2026-01-01" }, now).overdue, false);
});

test("a statement's document is posted once every line is dealt with", () => {
	assert.deepEqual(statementDocumentTags({ posted: 3, open: 1, entries: ["4", "5", "6"] }), { posted: null });
	assert.deepEqual(statementDocumentTags({ posted: 0, open: 0 }), { posted: null });
	assert.deepEqual(statementDocumentTags({ posted: 3, open: 0, entries: ["4", "5", "6"] }), { posted: "3 entries" });
	assert.deepEqual(statementDocumentTags({ posted: 2, open: 0, entries: ["9", "9"] }), { posted: "entry 9" });
});

/** One bill with its document; `bills` is the table the listener reads and writes. */
function setup(bill) {
	const documents = fakeDocuments();
	const doc = documents.put({ kind: "invoice", filename: "hydro.pdf", data: Buffer.from("%PDF-1.4 hydro") });
	const b = { id: 3n, kind: "bill", due_date: "2026-01-10", journal_entry_id: null, paid_entry_id: null, document_id: doc, ...bill };
	const posted = { payment: false };
	const q = async (sql, params = []) => {
		if (/SELECT document_id FROM bill_documents WHERE bill_id/.test(sql)) return { rows: [{ document_id: doc }], rowCount: 1 };
		if (/FROM bills b JOIN bill_documents d/.test(sql)) return { rows: String(params[0]) === String(doc) ? [{ ...b }] : [], rowCount: 1 };
		if (/UPDATE bills SET status = 'paid'/.test(sql)) {
			if (!["new", "open"].includes(b.status)) return { rows: [], rowCount: 0 };
			Object.assign(b, { status: "paid", paid_by_tag: true, paid_tag_by: params[1] });
			return { rows: [], rowCount: 1 };
		}
		if (/UPDATE bills SET status = 'open'/.test(sql)) return void Object.assign(b, { status: "open", paid_by_tag: false, paid_tag_by: null }) ?? { rows: [], rowCount: 1 };
		if (/SELECT 1 FROM transactions WHERE bill_id/.test(sql)) return { rows: posted.payment ? [{}] : [], rowCount: 0 };
		if (/SELECT statement_id FROM statement_files/.test(sql)) return { rows: [], rowCount: 0 };
		throw new Error(`unexpected SQL: ${sql}`);
	};
	const ctx = { id: "categorizer", documents: documents.api, log: { warn() {}, info() {} } };
	const dtags = documentTags(ctx, { q, T: (t) => t });
	const after = { calls: [], unlink: async () => after.calls.push("unlink"), autoMatch: async () => after.calls.push("autoMatch"), syncBillTodos: async () => after.calls.push("todos"), complete: async (k) => after.calls.push(`complete ${k}`), entryPaid: async () => after.calls.push("entry paid"), entryUnpaid: async () => after.calls.push("entry unpaid") };
	dtags.listen(after);
	const tagsOf = () => (documents.tags.get(doc) ?? []).map((t) => t.tag).sort();
	return { documents, doc, b, dtags, after, tagsOf, posted };
}

test("a bill's document carries posted (naming the entry), overdue, then paid", async () => {
	const S = setup({ status: "open", journal_entry_id: 12n });
	await S.dtags.syncBill(S.b, { username: "pat" });
	assert.deepEqual(S.tagsOf(), ["overdue", "posted"]);
	assert.equal(S.documents.tags.get(S.doc).find((t) => t.tag === "posted").note, "entry 12");
	// Its payment is posted: paid (which takes overdue off), and the note names both entries.
	Object.assign(S.b, { status: "paid", paid_entry_id: 15n });
	await S.dtags.syncBill(S.b);
	assert.deepEqual(S.tagsOf(), ["paid", "posted"]);
	assert.equal(S.documents.tags.get(S.doc).find((t) => t.tag === "posted").note, "entry 12, paid by entry 15");
	// Nothing changes on a second run.
	const n = S.documents.calls.length;
	await S.dtags.syncBill(S.b);
	assert.equal(S.documents.calls.length, n);
	// Approval undone: the document isn't posted or paid any more.
	Object.assign(S.b, { status: "new", journal_entry_id: null, paid_entry_id: null });
	await S.dtags.syncBill(S.b);
	assert.deepEqual(S.tagsOf(), []);
});

test("\"paid\" set on the bill's document by a person pays the bill here; taken off, it is unpaid again", async () => {
	const S = setup({ status: "open", journal_entry_id: 12n, due_date: "2026-12-31" });
	await S.documents.outside(S.doc, "set", "paid", { set_by: "sam" });
	assert.equal(S.b.status, "paid");
	assert.equal(S.b.paid_tag_by, "sam");
	// Its entry is told too: where Ledger keeps unpaid / partially_paid / paid on it (0.33.0), "paid" is set there by hand.
	assert.deepEqual(S.after.calls, ["entry paid", "unlink", "complete bill-3", "todos"]);
	await S.documents.outside(S.doc, "removed", "paid");
	assert.equal(S.b.status, "open");
	assert.deepEqual(S.after.calls.slice(4), ["entry unpaid", "autoMatch"]);
});

test("\"paid\" taken off a bill whose payment is in the journal is put back; so is \"posted\"", async () => {
	const S = setup({ status: "paid", journal_entry_id: 12n, paid_entry_id: 15n });
	await S.dtags.syncBill(S.b);
	await S.documents.outside(S.doc, "removed", "paid");
	assert.equal(S.b.status, "paid");
	assert.ok(S.tagsOf().includes("paid"));
	await S.documents.outside(S.doc, "removed", "posted");
	assert.ok(S.tagsOf().includes("posted"));
});

test("the module's own tag changes aren't acted on, and tags others set are left alone", async () => {
	const S = setup({ status: "new" });
	// Another module says the file is billed and posted: this bill has no entry, but their tags stay.
	await S.documents.outside(S.doc, "set", "billed", { module_id: "sales" });
	await S.documents.outside(S.doc, "set", "posted", { module_id: "sales" });
	await S.dtags.syncBill(S.b);
	assert.deepEqual(S.tagsOf(), ["billed", "posted"]);
	// A change announced as this module's own does nothing.
	S.documents.announce({ document_id: S.doc, action: "set", tag: "paid", module_id: "categorizer" });
	await new Promise((r) => setTimeout(r, 5));
	assert.equal(S.b.status, "new");
});

test("without file tags (an older Ledger) nothing happens and nothing fails", async () => {
	const dtags = documentTags({ id: "categorizer", documents: {}, log: { warn() {} } }, { q: async () => ({ rows: [] }), T: (t) => t });
	assert.equal(dtags.on, false);
	assert.equal(await dtags.syncBill({ id: 1n, status: "paid" }), null);
	assert.equal(await dtags.syncStatement(1), null);
	assert.equal(await dtags.set(4, "posted"), false);
});

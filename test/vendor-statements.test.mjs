// Vendor statements (0.31.0): a supplier's statement of account is recognised, kept as what it is
// (never a bill, nothing posted) and reconciled against the vendor's own account in Ledger.
// Since 0.32.0 they are listed with the other statements (GET /statements), and a statement staged
// for a bank or card account can be made one while nothing of it is posted, merged or linked.
// The pure parts run anywhere; the routes run on a scratch PostgreSQL (test/pg.mjs; skipped
// without one) with the stand-ins for Ledger's entities and ctx.reconcile (test/fake-ledger.mjs).

import assert from "node:assert/strict";
import { test } from "node:test";
import { extractBill, extractionSchema } from "../lib/bills.mjs";
import { parseEmail } from "../lib/mime.mjs";
import { addsUp, normalizeLines, reconcileInput, reconciliationState, statementFromReading } from "../lib/vendor-statements.mjs";
import { fakeDocuments, fakeReconcile, fakeVendors, start } from "./fake-ledger.mjs";
import { PDF, sampleEmail } from "./helpers.mjs";
import { scratchDatabase } from "./pg.mjs";

/** What the AI answers for a supplier's statement of account: two invoices, a payment, a credit note. */
const READING = {
	kind: "vendor_statement", vendor: "Acme Supply", invoice_number: "", bill_date: "2026-03-31", due_date: "", amount_due: "", currency: "CAD", account_code: "", confidence: 0.92,
	summary: "Statement of account for March", items: [],
	period_start: "2026-03-01", opening_balance: "0.00", closing_balance: "1,150.00",
	statement_lines: [
		{ date: "2026-03-05", description: "Invoice INV-101", amount: "500.00" },
		{ date: "2026-03-12", description: "Invoice INV-102", amount: "300.00" },
		{ date: "2026-03-20", description: "Payment received - thank you", amount: "-500.00" },
		{ date: "2026-03-28", description: "Invoice INV-103", amount: "900.00" },
		{ date: "2026-03-30", description: "Credit note CN-7", amount: "(50.00)" },
		{ date: "2026-03-31", description: "Balance", amount: "" },
		{ date: "", description: "Total", amount: "1150.00" },
	],
};
const LINES = [
	["2026-03-05", "Invoice INV-101", 50000n],
	["2026-03-12", "Invoice INV-102", 30000n],
	["2026-03-20", "Payment received - thank you", -50000n],
	["2026-03-28", "Invoice INV-103", 90000n],
	["2026-03-30", "Credit note CN-7", -5000n],
];

// ---------------------------------------------------------------------------
// Pure: the reading, the lines, what Ledger is given, what Ledger says
// ---------------------------------------------------------------------------

test("the reading step can say a document is a vendor statement, with its balances and signed lines", async () => {
	let sent;
	const llm = async (req) => ((sent = req), { data: READING });
	const email = parseEmail(sampleEmail());
	const x = await extractBill({ llm, readsPdf: true, email, pdfs: email.attachments, accounts: [{ code: "5300", name: "Phone", type: "expense" }] });
	assert.equal(x.kind, "vendor_statement");
	assert.equal(x.vendor, "Acme Supply");
	assert.equal(x.bill_date, "2026-03-31");
	assert.equal(x.amount_cents, null);
	assert.deepEqual(x.items, []);
	assert.equal(x.statement.period_start, "2026-03-01");
	assert.equal(x.statement.opening_balance_cents, 0n);
	assert.equal(x.statement.closing_balance_cents, 115000n);
	// Invoices and charges positive, payments and credit notes negative; rows without a date or an amount aren't lines.
	assert.deepEqual(x.statement.lines.map((l) => [l.date, l.description, l.amount_cents]), LINES);
	// The model is offered the kind and told what it is and isn't.
	assert.deepEqual(sent.schema.properties.kind.enum, ["bill", "receipt", "vendor_statement", "not_bill"]);
	assert.ok(sent.schema.required.includes("statement_lines") && sent.schema.required.includes("closing_balance"));
	assert.match(sent.system, /"vendor_statement": a supplier's statement of account/);
	assert.match(sent.system, /bank, credit-card or loan statement are not this/);
	assert.match(sent.system, /credit-card or loan statements with an amount due/); // those stay bills
	assert.deepEqual(extractionSchema([]).properties.statement_lines.items.required, ["date", "description", "amount"]);
});

test("a bill, a receipt and something else are read as before, without a statement", async () => {
	const email = parseEmail(sampleEmail());
	for (const kind of ["bill", "receipt", "not_bill"]) {
		const x = await extractBill({ llm: async () => ({ data: { ...READING, kind, amount_due: "85.50" } }), email, accounts: [] });
		assert.equal(x.kind, kind);
		assert.equal("statement" in x, false);
	}
	// A kind the model made up isn't a vendor statement.
	assert.equal((await extractBill({ llm: async () => ({ data: { ...READING, kind: "bank_statement" } }), email, accounts: [] })).kind, "not_bill");
});

test("statement lines are cleaned up: a date and an amount that isn't 0, in the order given", () => {
	assert.deepEqual(
		normalizeLines([
			{ date: "2026-03-05", description: "  Invoice   INV-1 ", amount: "1,200.50" },
			{ date: "2026-03-06", description: "Payment", amount: "-200" },
			{ date: "2026-03-07", description: "Nothing", amount: "0.00" },
			{ date: "soon", description: "No date", amount: "5" },
			{ date: "2026-03-08", amount_cents: -1234 },
			null,
		]),
		[
			{ date: "2026-03-05", description: "Invoice INV-1", amount_cents: 120050n },
			{ date: "2026-03-06", description: "Payment", amount_cents: -20000n },
			{ date: "2026-03-08", description: "", amount_cents: -1234n },
		],
	);
	assert.deepEqual(statementFromReading({ closing_balance: "", opening_balance: "-25.00", statement_lines: "none" }), { period_start: null, opening_balance_cents: -2500n, closing_balance_cents: null, lines: [] });
	const lines = normalizeLines(READING.statement_lines);
	assert.equal(addsUp({ opening_balance_cents: 0n, closing_balance_cents: 115000n }, lines), true);
	assert.equal(addsUp({ opening_balance_cents: 0n, closing_balance_cents: 100000n }, lines), false);
	assert.equal(addsUp({ opening_balance_cents: null, closing_balance_cents: 100000n }, lines), null);
});

test("what ctx.reconcile.start is given: the vendor's account, the document, the balance and the lines in the account's sign", () => {
	const lines = normalizeLines(READING.statement_lines);
	const { input } = reconcileInput({ accountCode: "2000-7", documentId: 31n, statement: { statement_date: "2026-03-31", closing_balance_cents: 115000n, opening_balance_cents: 0n, period_start: "2026-03-01" }, lines });
	assert.deepEqual(input, {
		account_code: "2000-7", document_id: 31, statement_date: "2026-03-31", statement_balance_cents: 115000, opening_balance_cents: 0, period_start: "2026-03-01",
		lines: LINES.map(([date, description, c]) => ({ date, description, amount_cents: Number(c) })),
	});
	// Without a document, an opening balance or a period, those are left out; lines may be none.
	assert.deepEqual(reconcileInput({ accountCode: "2000-7", statement: { statement_date: "2026-03-31", closing_balance_cents: -500n }, lines: [] }).input, { account_code: "2000-7", statement_date: "2026-03-31", statement_balance_cents: -500, lines: [] });
	assert.match(reconcileInput({ accountCode: "2000-7", statement: { closing_balance_cents: 1n }, lines }).error, /statement's date/);
	assert.match(reconcileInput({ accountCode: "2000-7", statement: { statement_date: "2026-03-31", closing_balance_cents: null }, lines }).error, /balance/);
});

test("a statement's state is what Ledger says about its reconciliation", () => {
	const open = { id: 9, status: "open", statement_date: "2026-03-31", created_by: "pat" };
	const done = { id: 9, status: "finished", statement_date: "2026-03-31", finished_at: new Date("2026-04-02T10:00:00Z"), finished_by: "sam" };
	assert.deepEqual(reconciliationState(null, []), { state: "none", other_open: null });
	// Deleted in Ledger since: not started again.
	assert.equal(reconciliationState(9, []).state, "none");
	assert.equal(reconciliationState(9, [open]).state, "open");
	assert.equal(reconciliationState(9, [open]).href, "/reconcile/9");
	const f = reconciliationState(9, [done]);
	assert.deepEqual([f.state, f.finished_at, f.finished_by, f.href], ["finished", "2026-04-02T10:00:00.000Z", "sam", "/reconcile/9"]);
	// Another reconciliation of the vendor's account is in progress.
	assert.deepEqual(reconciliationState(null, [{ ...open, id: 12 }]), { state: "none", other_open: { id: 12, href: "/reconcile/12", statement_date: "2026-03-31" } });
	assert.equal(reconciliationState(9, [{ ...open, id: 12 }, done]).other_open.id, 12);
	// The one in progress, in detail: the statement lines the books don't have.
	const reading = { lines: [{ date: "2026-03-05", description: "INV-101", amount_cents: 50000 }, { date: "2026-03-28", description: "INV-103", amount_cents: 90000 }], matched: [[1, 0]], unmatched: [1] };
	const d = reconciliationState(9, [open], { reconciliation: open, reading, difference_cents: 90000n, lines: [{ cleared: true }, { cleared: false }] });
	assert.deepEqual([d.state, d.matched, d.not_on_statement, d.difference_cents], ["open", 1, 1, 90000n]);
	assert.deepEqual(d.unmatched, [{ date: "2026-03-28", description: "INV-103", amount_cents: 90000 }]);
});

// ---------------------------------------------------------------------------
// The routes, on a scratch database
// ---------------------------------------------------------------------------

const CHART = () => [
	{ code: "1000", name: "Chequing", type: "asset", currency: "CAD", is_active: true, kind: "chequing", entity: null },
	{ code: "2000", name: "Accounts payable", type: "liability", currency: "CAD", is_active: true, kind: "payable", entity: null },
	{ code: "5100", name: "Supplies", type: "expense", currency: "CAD", is_active: true, kind: null, entity: null },
];

/**
 * The module on a scratch database with a Ledger that has vendors' own accounts and (unless
 * `older`) ctx.reconcile. reading: what the AI answers for a document (null: the AI isn't set up).
 */
async function setup(t, { older = false, reading = READING } = {}) {
	const db = await scratchDatabase();
	if (!db) return t.skip("no PostgreSQL to test with (TEST_DATABASE_URL)"), null;
	t.after(() => db.end());
	const chart = CHART();
	const vendors = fakeVendors(chart);
	const book = new Map();
	const reconcile = fakeReconcile(book, chart);
	const posted = [];
	const asked = [];
	const documents = fakeDocuments();
	const m = await start({
		answers: [[/./, (sql, params) => db.q(sql, params)]],
		documents,
		ledger: {
			listAccounts: async () => chart,
			getAccount: async (code) => chart.find((a) => a.code === code) ?? null,
			createJournalEntry: async (e) => (posted.push(e), { id: 500 + posted.length, ...e }),
			getJournalEntry: async () => null,
		},
		llm: reading
			? { status: async () => ({ configured: true, allowed: true, readsPdf: true, images: { configured: true } }), json: async (req) => (asked.push(req), { data: reading }) }
			: {},
		more: { ledgerVersion: older ? "0.33.0" : "0.34.0", entities: vendors.api, ...(older ? {} : { reconcile: reconcile.api }) },
	});
	const upload = (name = "acme-statement.pdf", bytes = PDF) => m.call("POST /bills/upload", { body: { filename: name, content_base64: bytes.toString("base64") } });
	return { ...m, db, chart, vendors, book, reconcile, posted, asked, upload };
}
const status = async (p) => p.then(() => 200, (e) => e.status ?? 500);

test("a document read as a vendor statement is kept as one: no bill, nothing posted, its lines as read", async (t) => {
	const s = await setup(t);
	if (!s) return;
	const made = (await s.upload()).body;
	assert.equal(made.kind, "vendor_statement");
	// Not on the Bills or Receipts tab, in no count, and no bill route acts on it.
	for (const query of ["", "kind=bill", "kind=receipt", "status=ignored", "status=new"]) assert.deepEqual((await s.call("GET /bills", { query })).data, [], query);
	const counts = await s.call("GET /counts");
	assert.deepEqual([counts.bills, counts.receipts, counts.overdue], [0, 0, 0]);
	assert.equal(await status(s.call("POST /bills/:id/approve", { params: { id: String(made.id) } })), 409);
	assert.equal(await status(s.call("PATCH /bills/:id", { params: { id: String(made.id) }, body: { status: "paid" } })), 409);
	assert.equal(await status(s.call("DELETE /bills/:id", { params: { id: String(made.id) } })), 409);
	assert.deepEqual((await s.call("GET /bills/:id", { params: { id: String(made.id) } })).bill, { id: made.id, kind: "vendor_statement", vendor: "Acme Supply" });
	assert.equal(s.posted.length, 0);
	assert.equal(s.dashboard.some(([call, x]) => call === "todo" && /bill/i.test(x?.title ?? "")), false);

	const list = await s.call("GET /vendor-statements");
	assert.equal(list.data.length, 1);
	assert.deepEqual(list.reconcile, { available: true, reason: "" });
	// The Statements tab gets it in the same answer as the bank and card statements, with what its row shows.
	const tab = await s.call("GET /statements");
	assert.deepEqual(tab.data, []);
	assert.deepEqual(tab.reconcile, { available: true, reason: "" });
	assert.deepEqual(
		tab.vendor_statements.map((v) => [v.id, v.vendor, v.statement_date, v.period_start, v.closing_balance_cents, v.currency, v.line_count, v.document_name, v.reconciliation.state]),
		[[made.id, "Acme Supply", "2026-03-31", "2026-03-01", 115000n, "CAD", 5, "acme-statement.pdf", "none"]],
	);
	assert.ok(tab.vendor_statements[0].created_at);
	const { statement, lines } = await s.call("GET /vendor-statements/:id", { params: { id: String(made.id) } });
	assert.deepEqual(
		[statement.vendor, statement.currency, statement.statement_date, statement.period_start, statement.opening_balance_cents, statement.closing_balance_cents, statement.read_by, statement.adds_up],
		["Acme Supply", "CAD", "2026-03-31", "2026-03-01", 0n, 115000n, "ai", true],
	);
	assert.deepEqual(lines.map((l) => [l.date, l.description, l.amount_cents]), LINES);
	assert.equal(statement.has_document, true);
	assert.deepEqual(statement.reconciliation, { state: "none", other_open: null });
	// The AI read the vendor's name: only a vendor Ledger already has is linked, none is added.
	assert.equal(statement.vendor_entity_id, null);
	assert.equal(s.vendors.entities.length, 0);
});

test("a person corrects what was read: vendor (added to Ledger's list), currency, dates, balances and lines", async (t) => {
	const s = await setup(t);
	if (!s) return;
	const id = String((await s.upload()).body.id);
	const r = await s.call("PATCH /vendor-statements/:id", { params: { id }, body: { vendor: "Acme Supply Ltd", currency: "USD", statement_date: "2026-04-01", period_start: "", opening_balance: "100", closing_balance: "-25.50" } });
	assert.deepEqual([r.statement.vendor, r.statement.currency, r.statement.statement_date, r.statement.period_start, r.statement.opening_balance_cents, r.statement.closing_balance_cents], ["Acme Supply Ltd", "USD", "2026-04-01", null, 10000n, -2550n]);
	assert.equal(r.statement.vendor_entity_id, 1n);
	assert.deepEqual(s.vendors.entities.map((e) => [e.name, [...e.roles]]), [["Acme Supply Ltd", ["vendor"]]]);
	const put = await s.call("PUT /vendor-statements/:id/lines", { params: { id }, body: { lines: [{ date: "2026-03-05", description: "INV-101", amount: "500.00" }, { date: "2026-03-20", description: "Payment", amount: "-625.50" }] } });
	assert.deepEqual(put.lines.map((l) => [l.line_no, l.date, l.description, l.amount_cents]), [[1, "2026-03-05", "INV-101", 50000n], [2, "2026-03-20", "Payment", -62550n]]);
	assert.equal(put.statement.read_by, "person");
	assert.equal(put.statement.adds_up, true);
	// Bad input is refused, and the lines stay.
	for (const body of [{}, { lines: "x" }, { lines: [{ date: "2026-03-05", amount: "0" }] }, { lines: [{ date: "tomorrow", amount: "5" }] }, { lines: [null] }]) {
		assert.equal(await status(s.call("PUT /vendor-statements/:id/lines", { params: { id }, body })), 422, JSON.stringify(body));
	}
	for (const body of [{}, { currency: "EUR" }, { statement_date: "soon" }, { closing_balance: "lots" }, { status: "open" }, { vendor: 5 }]) {
		assert.equal(await status(s.call("PATCH /vendor-statements/:id", { params: { id }, body })), 422, JSON.stringify(body));
	}
	assert.equal((await s.call("GET /vendor-statements/:id", { params: { id } })).lines.length, 2);
	assert.equal(await status(s.call("GET /vendor-statements/:id", { params: { id: "999" } })), 404);
});

test("by hand: a bill becomes a vendor statement and a bill again", async (t) => {
	const s = await setup(t, { reading: { ...READING, kind: "bill", vendor: "Acme Supply", invoice_number: "ST-3", amount_due: "1150.00", account_code: "5100", statement_lines: [], closing_balance: "", opening_balance: "", period_start: "" } });
	if (!s) return;
	const bill = (await s.upload()).body;
	assert.deepEqual([bill.kind, bill.status, bill.amount_cents], ["bill", "new", 115000n]);
	const id = String(bill.id);
	assert.equal((await s.call("GET /bills", { query: "kind=bill" })).data.length, 1);

	const r = await s.call("POST /bills/:id/vendor-statement", { params: { id } });
	assert.deepEqual([r.statement.id, r.statement.vendor, r.statement.statement_date, r.statement.was_kind, r.statement.closing_balance_cents, r.lines.length], [bill.id, "Acme Supply", "2026-03-31", "bill", null, 0]);
	assert.equal(r.statement.has_document, true);
	assert.deepEqual((await s.call("GET /bills", { query: "" })).data, []);
	assert.equal((await s.call("GET /vendor-statements")).data.length, 1);
	assert.equal(await status(s.call("POST /bills/:id/approve", { params: { id } })), 409);
	// Said twice: it is one already.
	assert.equal((await s.call("POST /bills/:id/vendor-statement", { params: { id } })).statement.id, bill.id);

	// And back: the bill it was, still to review, with what was read of it.
	await s.call("PUT /vendor-statements/:id/lines", { params: { id }, body: { lines: [{ date: "2026-03-05", description: "INV-101", amount: "500" }] } });
	const back = await s.call("POST /vendor-statements/:id/bill", { params: { id }, body: {} });
	assert.deepEqual([back.id, back.kind, back.status, back.vendor, back.invoice_number, back.amount_cents, back.account_code], [bill.id, "bill", "new", "Acme Supply", "ST-3", 115000n, "5100"]);
	assert.deepEqual((await s.call("GET /vendor-statements")).data, []);
	assert.equal(await status(s.call("GET /vendor-statements/:id", { params: { id } })), 404);
	assert.equal((await s.call("GET /bills", { query: "kind=bill&status=new" })).data.length, 1);
	// As a receipt this time; then a statement again, with the lines typed before.
	await s.call("POST /bills/:id/vendor-statement", { params: { id } });
	assert.equal((await s.call("GET /vendor-statements/:id", { params: { id } })).lines.length, 1);
	assert.equal((await s.call("POST /vendor-statements/:id/bill", { params: { id }, body: { kind: "receipt" } })).kind, "receipt");
	assert.equal(await status(s.call("POST /vendor-statements/:id/bill", { params: { id }, body: { kind: "statement" } })), 404); // it is a receipt now
	assert.equal(s.posted.length, 0);
});

test("by hand: something read as \"not a bill\" and a bill added by hand can be made a vendor statement; a bill that posted something can't", async (t) => {
	const s = await setup(t, { reading: { ...READING, kind: "not_bill", statement_lines: [], closing_balance: "" } });
	if (!s) return;
	const other = (await s.upload()).body;
	assert.equal(other.kind, "bill"); // kept for review, with the note that it doesn't look like a bill
	assert.equal((await s.call("POST /bills/:id/vendor-statement", { params: { id: String(other.id) } })).statement.was_kind, "bill");

	const hand = (await s.call("POST /bills", { body: { vendor: "Globex", kind: "bill", amount: "40.00", bill_date: "2026-03-10" } })).body;
	// Approved into payables: it has an entry in the books.
	await s.db.q(`UPDATE mod_categorizer.bills SET status = 'open', journal_entry_id = 77, ap_account = '2000' WHERE id = $1`, [hand.id]);
	const err = await s.call("POST /bills/:id/vendor-statement", { params: { id: String(hand.id) } }).catch((e) => e);
	assert.equal(err.status, 409);
	assert.match(err.message, /posted to payables \(entry #77\); undo the approval first/);
	// Linked to a payment entry, or paid by a posted statement row: the same.
	await s.db.q(`UPDATE mod_categorizer.bills SET status = 'paid', journal_entry_id = NULL, paid_entry_id = 78 WHERE id = $1`, [hand.id]);
	assert.match((await s.call("POST /bills/:id/vendor-statement", { params: { id: String(hand.id) } }).catch((e) => e)).message, /linked to journal entry #78/);
	await s.db.q(`UPDATE mod_categorizer.bills SET status = 'open', paid_entry_id = NULL WHERE id = $1`, [hand.id]);
	const { rows: st } = await s.db.q(`INSERT INTO mod_categorizer.statements (filename, format, account_code, uploaded_by) VALUES ('march.csv', 'csv', '1000', 'pat') RETURNING id`);
	await s.db.q(`INSERT INTO mod_categorizer.transactions (statement_id, line_no, fingerprint, account_code, tx_date, description, amount_cents, status, bill_id, journal_entry_id) VALUES ($1, 1, 'f1', '1000', '2026-03-15', 'GLOBEX', -4000, 'posted', $2, 79)`, [st[0].id, hand.id]);
	assert.match((await s.call("POST /bills/:id/vendor-statement", { params: { id: String(hand.id) } }).catch((e) => e)).message, /a payment of this bill is posted/);
	assert.equal((await s.call("GET /bills/:id", { params: { id: String(hand.id) } })).bill.kind, "bill");
});

/** A statement staged for the chequing account: two "deposits" (a supplier's invoices) and a "withdrawal" (our payment), with its file in Documents. */
async function staged(s, { status = "ready", name = "acme-march.csv" } = {}) {
	const doc = await s.documents.api.add({ kind: "statement", filename: name, data: Buffer.from(`date,description,amount\n${name}\n`), content_type: "text/csv", account_code: "1000" }, { username: "pat" });
	const { rows } = await s.db.q(`INSERT INTO mod_categorizer.statements (filename, format, account_code, uploaded_by, status) VALUES ('acme-march.csv', 'csv', '1000', 'pat', $1) RETURNING id`, [status]);
	const id = rows[0].id;
	await s.db.q(`INSERT INTO mod_categorizer.statement_files (statement_id, file_name, content_type, size_bytes, document_id) VALUES ($1, 'acme-march.csv', 'text/csv', 24, $2)`, [id, doc.id]);
	const tx = [];
	for (const [n, date, description, cents] of [[1, "2026-03-05", "Invoice INV-101", 50000], [2, "2026-03-12", "Invoice INV-102", 30000], [3, "2026-03-20", "Payment received", -50000], [4, "2026-03-31", "Balance", 0]]) {
		tx.push((await s.db.q(`INSERT INTO mod_categorizer.transactions (statement_id, line_no, fingerprint, account_code, tx_date, description, amount_cents, suggested_code, source) VALUES ($1, $2, $3, '1000', $4, $5, $6, '5100', 'llm') RETURNING id`, [id, n, `f${id}-${n}`, date, description, cents])).rows[0].id);
	}
	return { id: String(id), doc: doc.id, tx };
}

test("a statement staged for a bank account is made a vendor's statement: its rows become the lines, its document goes along, nothing is posted", async (t) => {
	const s = await setup(t);
	if (!s) return;
	const st = await staged(s);
	// A bill the AI's matching offered one of its rows: only an offer, it is free again afterwards.
	const bill = (await s.call("POST /bills", { body: { vendor: "Globex", kind: "bill", amount: "500.00", bill_date: "2026-03-10" } })).body;
	await s.db.q(`UPDATE mod_categorizer.transactions SET bill_id = $2, source = 'bill' WHERE id = $1`, [st.tx[2], bill.id]);
	await s.db.q(`INSERT INTO mod_categorizer.inbox_files (name, size_bytes, status, received_by, statement_id, sent_to, sent_link, document_id) VALUES ('acme-march.csv', 24, 'sent', 'pat', $1, 'Statement', '/apps/categorizer?statement=1', $2)`, [st.id, st.doc]);
	assert.equal((await s.call("GET /statements")).data.length, 1);

	for (const body of [{}, { vendor: "" }, { vendor: 7 }, { vendor: "Acme Supply", currency: "EUR" }]) {
		assert.equal(await status(s.call("POST /statements/:id/vendor-statement", { params: { id: st.id }, body })), 422, JSON.stringify(body));
	}
	assert.equal(await status(s.call("POST /statements/:id/vendor-statement", { params: { id: "999" }, body: { vendor: "Acme Supply" } })), 404);

	const r = await s.call("POST /statements/:id/vendor-statement", { params: { id: st.id }, body: { vendor: "Acme Supply" } });
	assert.deepEqual(
		[r.statement.vendor, r.statement.vendor_entity_id, r.statement.currency, r.statement.statement_date, r.statement.period_start, r.statement.closing_balance_cents, r.statement.document_id, r.statement.document_name, r.statement.reconciliation.state],
		["Acme Supply", 2n, "CAD", "2026-03-20", "2026-03-05", null, BigInt(st.doc), "acme-march.csv", "none"],
	);
	assert.match(r.statement.error, /staged as a statement of 1000 Chequing before pat said it is a statement of account from Acme Supply\./);
	// The rows as they were staged, in order; the row without an amount isn't a line.
	assert.deepEqual(r.lines.map((l) => [l.line_no, l.date, l.description, l.amount_cents]), [[1, "2026-03-05", "Invoice INV-101", 50000n], [2, "2026-03-12", "Invoice INV-102", 30000n], [3, "2026-03-20", "Payment received", -50000n]]);
	// A person chose the vendor: it is in Ledger's list.
	assert.deepEqual(s.vendors.entities.map((e) => [e.name, [...e.roles]]), [["Globex", ["vendor"]], ["Acme Supply", ["vendor"]]]);
	// The staged statement and its rows are gone; the tab lists a vendor statement in its place.
	const tab = await s.call("GET /statements");
	assert.deepEqual([tab.data.length, tab.vendor_statements.map((v) => v.id)], [0, [r.statement.id]]);
	assert.equal((await s.db.q(`SELECT count(*)::int AS n FROM mod_categorizer.transactions`)).rows[0].n, 0);
	assert.equal(await status(s.call("GET /statements/:id", { params: { id: st.id } })), 404);
	// The same document, kept: no longer the bank account's statement in Documents, but this vendor's.
	assert.equal(s.documents.calls.some((c) => c[0] === "remove"), false);
	assert.deepEqual(s.documents.calls.filter((c) => c[0] === "update").map((c) => [c[1], c[2].kind, c[2].account_code, c[2].entity_id, c[2].doc_date]), [[st.doc, "statement", null, 2, "2026-03-20"]]);
	// The inbox file it came from says what it is now and opens it.
	const { rows: inbox } = await s.db.q(`SELECT statement_id, bill_id, sent_to, sent_link FROM mod_categorizer.inbox_files`);
	assert.deepEqual(inbox, [{ statement_id: null, bill_id: r.statement.id, sent_to: `Vendor statement #${r.statement.id} (Acme Supply)`, sent_link: `/apps/categorizer?bill=${r.statement.id}` }]);
	assert.equal(s.posted.length, 0);

	// From there it is a vendor statement like any other: the balance is entered, and Reconcile goes to Ledger.
	const id = String(r.statement.id);
	assert.match((await s.call("POST /vendor-statements/:id/reconcile", { params: { id } }).catch((e) => e)).message, /enter the balance/);
	await s.call("PATCH /vendor-statements/:id", { params: { id }, body: { closing_balance: "300.00" } });
	const go = await s.call("POST /vendor-statements/:id/reconcile", { params: { id } });
	assert.equal(go.href, `/reconcile/${go.reconciliation_id}`);
	const [, input] = s.reconcile.calls.find((c) => c[0] === "start");
	assert.deepEqual([input.account_code, input.document_id, input.statement_balance_cents, input.lines.length], ["2000-2", st.doc, 30000, 3]);
});

test("a statement that posted, merged or linked something stays a statement, and the answer says why", async (t) => {
	const s = await setup(t);
	if (!s) return;
	const st = await staged(s, { status: "categorizing" });
	const tx = `mod_categorizer.transactions`;
	const why = async () => {
		const e = await s.call("POST /statements/:id/vendor-statement", { params: { id: st.id }, body: { vendor: "Acme Supply" } }).catch((x) => x);
		assert.equal(e.status, 409);
		assert.match(e.message, /^This statement can't become a vendor's statement: /);
		return e.message;
	};
	assert.match(await why(), /wait until the suggestions are done/);
	await s.db.q(`UPDATE mod_categorizer.statements SET status = 'ready' WHERE id = $1`, [st.id]);

	await s.db.q(`UPDATE ${tx} SET status = 'posted', journal_entry_id = 91 WHERE id = $1`, [st.tx[0]]);
	assert.match(await why(), /1 of its transactions is posted to 1000; a statement that has posted something stays that account's statement/);
	await s.db.q(`UPDATE ${tx} SET status = 'new', journal_entry_id = NULL WHERE id = $1`, [st.tx[0]]);

	await s.db.q(`UPDATE ${tx} SET status = 'merged', duplicate_entry_id = 92 WHERE id = ANY($1::bigint[])`, [[st.tx[0], st.tx[1]]]);
	assert.match(await why(), /2 of its transactions are merged as duplicates; unmerge them first/);
	await s.db.q(`UPDATE ${tx} SET status = 'new', duplicate_entry_id = NULL WHERE statement_id = $1`, [st.id]);

	// A row of another statement merged into one of its rows.
	const other = await staged(s, { name: "other.csv" });
	await s.db.q(`UPDATE ${tx} SET status = 'merged', duplicate_of = $2 WHERE id = $1`, [other.tx[0], st.tx[0]]);
	assert.match(await why(), /1 transaction of another statement is merged into this one as a duplicate/);
	await s.db.q(`UPDATE ${tx} SET status = 'new', duplicate_of = NULL WHERE id = $1`, [other.tx[0]]);

	// A person linked a row to a bill as its payment.
	const bill = (await s.call("POST /bills", { body: { vendor: "Globex", kind: "bill", amount: "500.00", bill_date: "2026-03-10" } })).body;
	await s.db.q(`UPDATE ${tx} SET bill_id = $2, chosen_code = '2000', source = 'bill' WHERE id = $1`, [st.tx[2], bill.id]);
	assert.match(await why(), new RegExp(`line 3 is linked to bill #${bill.id} as its payment; unlink it first`));
	await s.db.q(`UPDATE ${tx} SET bill_id = NULL, chosen_code = NULL, source = '' WHERE id = $1`, [st.tx[2]]);

	// Create bill was used on it.
	await s.db.q(`UPDATE mod_categorizer.bills SET statement_id = $2 WHERE id = $1`, [bill.id, st.id]);
	assert.match(await why(), new RegExp(`bill #${bill.id} was made from this statement \\(Create bill\\); delete that bill first`));
	await s.db.q(`UPDATE mod_categorizer.bills SET statement_id = NULL WHERE id = $1`, [bill.id]);

	// Nothing was changed by any of the refusals; with nothing in the way it goes through.
	assert.equal((await s.call("GET /statements")).data.length, 2);
	assert.equal((await s.call("GET /vendor-statements")).data.length, 0);
	assert.equal((await s.call("POST /statements/:id/vendor-statement", { params: { id: st.id }, body: { vendor: "Acme Supply", currency: "USD" } })).statement.currency, "USD");
	assert.deepEqual((({ data, vendor_statements }) => [data.length, vendor_statements.length])(await s.call("GET /statements")), [1, 1]);
});

/** A vendor statement with its vendor in Ledger and two bills and a payment in the vendor's account. */
async function reviewed(s) {
	const id = String((await s.upload()).body.id);
	await s.call("PATCH /vendor-statements/:id", { params: { id }, body: { vendor: "Acme Supply" } });
	const acc = await s.vendors.api.account(1, "vendor", "CAD");
	s.book.set(acc.code, [
		{ transaction_id: 11, entry_date: "2026-03-05", amount_cents: 50000n, description: "Bill INV-101" },
		{ transaction_id: 12, entry_date: "2026-03-12", amount_cents: 30000n, description: "Bill INV-102" },
		{ transaction_id: 13, entry_date: "2026-03-19", amount_cents: -50000n, description: "Payment" },
		{ transaction_id: 14, entry_date: "2026-03-29", amount_cents: 7500n, description: "Bill the statement doesn't list" },
	]);
	return { id, acc };
}

test("Start reconcile session: the vendor's own account, the document and the lines as read go to Ledger, and its state is read back", async (t) => {
	const s = await setup(t);
	if (!s) return;
	const { id, acc } = await reviewed(s);
	assert.equal(acc.code, "2000-1");
	const asked = s.asked.length;
	const r = await s.call("POST /vendor-statements/:id/reconcile", { params: { id } });
	assert.deepEqual([r.href, r.already_open, r.message], [`/reconcile/${r.reconciliation_id}`, false, ""]);
	// One start, for the vendor's own account (not accounts payable), by the person, with the module's reading.
	const starts = s.reconcile.calls.filter((c) => c[0] === "start");
	assert.equal(starts.length, 1);
	const [, input, by] = starts[0];
	assert.equal(by, "pat");
	const doc = (await s.call("GET /vendor-statements/:id", { params: { id } })).statement.document_id;
	assert.deepEqual(input, {
		account_code: "2000-1", document_id: Number(doc), statement_date: "2026-03-31", statement_balance_cents: 115000, opening_balance_cents: 0, period_start: "2026-03-01",
		// Invoices positive, the payment and the credit note negative: the vendor account's own sign.
		lines: LINES.map(([date, description, c]) => ({ date, description, amount_cents: Number(c) })),
	});
	// The AI isn't asked again, and nothing is posted.
	assert.equal(s.asked.length, asked);
	assert.equal(s.posted.length, 0);
	// Its document is the vendor's statement in Ledger's Documents.
	assert.deepEqual(s.documents.calls.filter((c) => c[0] === "update").map((c) => [c[1], c[2].kind, c[2].entity_id]), [[Number(doc), "statement", 1]]);

	// Only the id is kept; in progress, and what Ledger found, is read from Ledger.
	const { rows } = await s.db.q(`SELECT reconciliation_id, started_by FROM mod_categorizer.vendor_statements WHERE bill_id = $1`, [id]);
	assert.deepEqual(rows, [{ reconciliation_id: BigInt(r.reconciliation_id), started_by: "pat" }]);
	const rec = r.statement.reconciliation;
	assert.deepEqual([rec.state, rec.id, rec.href, rec.account_code, rec.matched, rec.not_on_statement], ["open", r.reconciliation_id, r.href, "2000-1", 3, 1]);
	// The statement lines the books don't have: the invoice to go and find, and the credit note.
	assert.deepEqual(rec.unmatched, [{ date: "2026-03-28", description: "Invoice INV-103", amount_cents: 90000 }, { date: "2026-03-30", description: "Credit note CN-7", amount_cents: -5000 }]);
	assert.equal((await s.call("GET /vendor-statements")).data[0].reconciliation.state, "open");
	const listed = (await s.call("GET /statements")).vendor_statements[0].reconciliation;
	assert.deepEqual([listed.state, listed.href, listed.id], ["open", r.href, r.reconciliation_id]);

	// Pressed again: the same one, nothing new started.
	const again = await s.call("POST /vendor-statements/:id/reconcile", { params: { id } });
	assert.deepEqual([again.already_open, again.reconciliation_id, again.href], [true, r.reconciliation_id, r.href]);
	assert.match(again.message, /already in progress/);
	assert.equal(s.reconcile.calls.filter((c) => c[0] === "start").length, 1);
	// While it is being reconciled it stays a vendor statement.
	assert.equal(await status(s.call("POST /vendor-statements/:id/bill", { params: { id }, body: {} })), 409);

	// Finished in Ledger: reconciled, on that day, by that person; no copy here to go stale.
	s.reconcile.finish(r.reconciliation_id, "sam");
	const done = (await s.call("GET /vendor-statements/:id", { params: { id } })).statement.reconciliation;
	assert.deepEqual([done.state, done.finished_by, done.href, done.finished_at.slice(0, 4)], ["finished", "sam", r.href, String(new Date().getUTCFullYear())]);
	assert.equal((await s.call("GET /vendor-statements")).data[0].reconciliation.state, "finished");
	assert.deepEqual((({ state, finished_by }) => [state, finished_by])((await s.call("GET /statements")).vendor_statements[0].reconciliation), ["finished", "sam"]);
	assert.equal(await status(s.call("POST /vendor-statements/:id/reconcile", { params: { id } })), 409);
	// Deleted in Ledger: not started again here, and it can be started anew.
	s.reconcile.remove(r.reconciliation_id);
	assert.equal((await s.call("GET /vendor-statements/:id", { params: { id } })).statement.reconciliation.state, "none");
	assert.equal((await s.call("POST /vendor-statements/:id/reconcile", { params: { id } })).already_open, false);
});

test("a reconciliation of the vendor already in progress is linked to, not replaced and not an error", async (t) => {
	const s = await setup(t);
	if (!s) return;
	const { id, acc } = await reviewed(s);
	// Someone started one for this vendor in Ledger (another statement).
	const other = await s.reconcile.api.start({ account_code: acc.code, statement_date: "2026-02-28", statement_balance_cents: 0 }, { username: "sam" });
	const before = s.reconcile.calls.filter((c) => c[0] === "start").length;
	const r = await s.call("POST /vendor-statements/:id/reconcile", { params: { id } });
	assert.deepEqual([r.already_open, r.reconciliation_id, r.href], [true, other.reconciliation.id, other.href]);
	assert.match(r.message, /^A reconciliation of this vendor is already in progress \(statement of 2026-02-28\)/);
	assert.equal(s.reconcile.calls.filter((c) => c[0] === "start").length, before);
	// It isn't this statement's: nothing is kept, and the statement says another one is in the way.
	assert.deepEqual((await s.db.q(`SELECT reconciliation_id FROM mod_categorizer.vendor_statements WHERE bill_id = $1`, [id])).rows, [{ reconciliation_id: null }]);
	assert.deepEqual([r.statement.reconciliation.state, r.statement.reconciliation.other_open.href], ["none", other.href]);
	// Once that one is finished, this statement's can start.
	s.reconcile.finish(other.reconciliation.id);
	const mine = await s.call("POST /vendor-statements/:id/reconcile", { params: { id } });
	assert.equal(mine.already_open, false);
	assert.notEqual(mine.reconciliation_id, other.reconciliation.id);
});

test("starting needs a vendor, a date and a balance; the vendor is added to Ledger's list by the person who starts", async (t) => {
	const s = await setup(t, { reading: { ...READING, vendor: "", bill_date: "", closing_balance: "" } });
	if (!s) return;
	const id = String((await s.upload()).body.id);
	const fail = async () => (await s.call("POST /vendor-statements/:id/reconcile", { params: { id } }).catch((e) => e));
	assert.deepEqual([(await fail()).status, (await fail()).message], [422, "choose the vendor first"]);
	// A vendor Ledger already has is linked without adding one; here it is new.
	await s.db.q(`UPDATE mod_categorizer.bills SET vendor = 'Initech' WHERE id = $1`, [id]);
	assert.match((await fail()).message, /statement's date/);
	assert.deepEqual(s.vendors.entities.map((e) => e.name), ["Initech"]);
	await s.call("PATCH /vendor-statements/:id", { params: { id }, body: { statement_date: "2026-03-31" } });
	assert.match((await fail()).message, /balance/);
	assert.equal(s.reconcile.calls.filter((c) => c[0] === "start").length, 0);
	await s.call("PATCH /vendor-statements/:id", { params: { id }, body: { closing_balance: "0" } });
	assert.equal((await s.call("POST /vendor-statements/:id/reconcile", { params: { id } })).already_open, false);
});

test("an older Ledger: the statement is still recognised and kept, with a note that reconciling needs a newer Ledger", async (t) => {
	const s = await setup(t, { older: true });
	if (!s) return;
	const made = (await s.upload()).body;
	assert.equal(made.kind, "vendor_statement");
	assert.deepEqual((await s.call("GET /bills", { query: "" })).data, []);
	const list = await s.call("GET /vendor-statements");
	assert.equal(list.reconcile.available, false);
	assert.match(list.reconcile.reason, /needs Ledger 0\.34\.0 or later \(this is Ledger 0\.33\.0\)/);
	assert.equal(list.data[0].reconciliation.state, "unavailable");
	const id = String(made.id);
	// It can be reviewed and corrected all the same; only starting is refused, with the reason.
	assert.equal((await s.call("PATCH /vendor-statements/:id", { params: { id }, body: { vendor: "Acme Supply" } })).statement.reconciliation.state, "unavailable");
	const err = await s.call("POST /vendor-statements/:id/reconcile", { params: { id } }).catch((e) => e);
	assert.equal(err.status, 409);
	assert.match(err.message, /needs Ledger 0\.34\.0 or later/);
	// And changed by hand both ways.
	assert.equal((await s.call("POST /vendor-statements/:id/bill", { params: { id }, body: {} })).kind, "bill");
	assert.equal((await s.call("POST /bills/:id/vendor-statement", { params: { id } })).statement.id, made.id);
	assert.equal(s.posted.length, 0);
});

test("a person says a file is a vendor statement where the AI can't read it: kept unread, to fill in by hand", async (t) => {
	const s = await setup(t, { reading: null });
	if (!s) return;
	const doc = s.documents.put({ kind: "other", filename: "acme.pdf", content_type: "application/pdf", data: PDF });
	const { rows } = await s.db.q(
		`INSERT INTO mod_categorizer.inbox_files (name, content_type, size_bytes, status, received_by, document_id, origin) VALUES ('acme.pdf', 'application/pdf', $1, 'new', 'pat', $2, 'upload') RETURNING id`,
		[PDF.length, doc],
	);
	// As a bill it can't be read without the AI...
	assert.equal(await status(s.call("POST /inbox/:id/bill", { params: { id: String(rows[0].id) }, body: { kind: "bill" } })), 422);
	// ...as a vendor statement it is kept, pointing at the same document.
	const r = await s.call("POST /inbox/:id/bill", { params: { id: String(rows[0].id) }, body: { kind: "vendor_statement" } });
	assert.equal(r.bill.kind, "vendor_statement");
	assert.match(r.sent_to, /^Vendor statement #/);
	const { statement, lines } = await s.call("GET /vendor-statements/:id", { params: { id: String(r.bill.id) } });
	assert.deepEqual([statement.vendor, statement.statement_date, statement.closing_balance_cents, statement.read_by, lines.length, Number(statement.document_id)], ["", null, null, "", 0, doc]);
	assert.match(statement.error, /enter the statement's date, balance and lines by hand/);
	// Deleted: the row and its lines go; the inbox file keeps the document.
	await s.call("DELETE /vendor-statements/:id", { params: { id: String(r.bill.id) } });
	assert.deepEqual((await s.call("GET /vendor-statements")).data, []);
	assert.ok(s.documents.docs.has(doc));
});

test("the stand-in for ctx.reconcile: one reconciliation in progress per account, lines validated, matches ticked once", async () => {
	const chart = CHART();
	chart.push({ code: "2000-1", name: "Acme", type: "liability", currency: "CAD", entity: { id: 1, name: "Acme", role: "vendor" } });
	const rc = fakeReconcile(new Map([["2000-1", [{ transaction_id: 1, entry_date: "2026-03-05", amount_cents: 500n }, { transaction_id: 2, entry_date: "2026-03-06", amount_cents: 500n }]]]), chart);
	await assert.rejects(rc.api.start({ account_code: "nope", statement_date: "2026-03-31", statement_balance_cents: 0 }), { status: 422 });
	assert.equal(await rc.api.open("2000-1"), null);
	const r = await rc.api.start({ account_code: "2000-1", statement_date: "2026-03-31", statement_balance_cents: 500, lines: [{ date: "2026-03-05", description: "a", amount_cents: 500 }, { date: "2026-01-01", description: "b", amount_cents: 500 }] }, { username: "pat" });
	assert.deepEqual([r.reconciliation.entity_role, r.reading.matched, r.reading.unmatched, r.difference_cents], ["vendor", [[1, 0]], [1], 0n]);
	assert.equal((await rc.api.start({ account_code: "2000-1" })).reconciliation.id, r.reconciliation.id);
	assert.equal((await rc.api.open("2000-1")).href, r.href);
	rc.finish(r.reconciliation.id);
	assert.equal(await rc.api.open("2000-1"), null);
	assert.deepEqual((await rc.api.list("2000-1")).map((x) => x.status), ["finished"]);
	await assert.rejects(rc.api.start({ account_code: "2000-1", statement_date: "2026-02-28", statement_balance_cents: 0 }), /before the last reconciled statement/);
	await assert.rejects(rc.api.start({ account_code: "2000-1", statement_date: "2026-04-30", statement_balance_cents: 0, lines: [{ date: "2026-04-01", amount_cents: 0 }] }), /lines\[0\]/);
});

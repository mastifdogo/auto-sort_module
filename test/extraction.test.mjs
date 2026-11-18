// lib/extraction.mjs: the module's shapes as the keys Ledger's modules share (ctx.documents.extracted), and back.
import assert from "node:assert/strict";
import { test } from "node:test";
import { billData, billFromData, billInfoData, billInfoFromData, centsToDecimal, decimalToCents, flippedData, parsedFromExtraction, rowsData, rowsFromData, statementData } from "../lib/extraction.mjs";
import { parseStatement } from "../lib/parse.mjs";
import { draftFromBillInfo } from "../lib/bills.mjs";

const viaJson = (x) => JSON.parse(JSON.stringify(x)); // what Ledger keeps: plain JSON

test("a parsed statement is saved under the shared keys and comes back as the same lines", () => {
	const parsed = parseStatement("Date,Description,Amount\n2026-10-01,METRO GROCERY,-45.10\n2026-10-03,PAYROLL,2500.00\n", { filename: "oct.csv" });
	const data = viaJson(statementData(parsed, { currency: "CAD", accountHint: "4411" }));
	assert.equal(data.type, "statement");
	assert.equal(data.currency, "CAD");
	assert.deepEqual(data.account, { number_last4: "4411" });
	assert.deepEqual(data.period, { from: "2026-10-01", to: "2026-10-03" });
	// Integer cents, money out negative.
	assert.deepEqual(data.transactions, [{ date: "2026-10-01", description: "METRO GROCERY", amount_cents: -4510 }, { date: "2026-10-03", description: "PAYROLL", amount_cents: 250000 }]);
	assert.equal(data.categorizer.format, "csv");
	const back = parsedFromExtraction(data);
	assert.equal(back.format, "csv");
	assert.deepEqual(back.transactions.map((t) => [t.line, t.date, t.description, t.amount_cents, t.fitid]), [[1, "2026-10-01", "METRO GROCERY", -4510n, ""], [2, "2026-10-03", "PAYROLL", 250000n, ""]]);
});

test("an OFX file's bank ids, memos and balance survive, so the same lines are recognised again", () => {
	const ofx = `OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><ACCTID>000111224411</BANKACCTFROM>
<BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261002<TRNAMT>-20.00<FITID>A1<NAME>SHELL<MEMO>fuel</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261005<TRNAMT>100.00<FITID>A2<NAME>REFUND</STMTTRN></BANKTRANLIST>
<LEDGERBAL><BALAMT>-512.34<DTASOF>20261031</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
	const parsed = parseStatement(ofx, { filename: "card.ofx" });
	const data = viaJson(statementData(parsed));
	assert.deepEqual(data.categorizer.bank_ids, ["A1", "A2"]);
	assert.equal(data.closing_balance_cents, -51234);
	const back = parsedFromExtraction(data);
	assert.deepEqual(back.transactions.map((t) => [t.fitid, t.memo, t.amount_cents]), parsed.transactions.map((t) => [t.fitid, t.memo, t.amount_cents]));
	assert.deepEqual(back.balance, { amount_cents: -51234n, date: "2026-10-31" });
	// The balance says what is owed on a card: Create bill needs no AI.
	const draft = draftFromBillInfo(billInfoFromData(data), { account: { code: "2100", name: "Visa", type: "liability", currency: "CAD" }, last: "2026-10-05" });
	assert.equal(draft.amount_cents, 51234n);
	assert.equal(draft.read_from, "saved");
});

test("flip signs: what is saved has money out negative, and staging gets the file's own signs back", () => {
	// A card export with purchases as positive amounts.
	const parsed = parseStatement("Date,Description,Amount\n2026-10-01,COFFEE,4.50\n2026-10-02,PAYMENT,-100.00\n", { filename: "card.csv" });
	const data = viaJson(statementData(parsed, { flipped: true }));
	assert.deepEqual(data.transactions.map((t) => t.amount_cents), [-450, 10000]);
	assert.equal(data.categorizer.flipped, true);
	assert.deepEqual(parsedFromExtraction(data).transactions.map((t) => t.amount_cents), [450n, -10000n]);
	// The person changes their mind: only then is something saved again.
	assert.equal(flippedData(data, true), null);
	const turned = flippedData(data, false);
	assert.deepEqual(turned.transactions.map((t) => t.amount_cents), [450, -10000]);
	assert.equal(turned.categorizer.flipped, false);
});

test("what another module read (no key of ours) is used as it is; rubbish is left out", () => {
	const back = parsedFromExtraction({ type: "statement", transactions: [{ date: "2026-09-30", description: "RENT", amount_cents: -120000 }, { date: "30/09/2026", description: "bad date", amount_cents: -1 }, { date: "2026-09-30", description: "no amount" }, { date: "2026-09-30", description: "zero", amount_cents: 0 }] });
	assert.equal(back.format, "extracted");
	assert.deepEqual(back.transactions.map((t) => [t.line, t.description, t.amount_cents]), [[1, "RENT", -120000n]]);
	assert.match(back.warnings[0], /3 lines/);
	assert.equal(parsedFromExtraction({ type: "bill", vendor: "Hydro" }), null);
	assert.equal(parsedFromExtraction(null), null);
	assert.equal(parsedFromExtraction({ transactions: [] }), null);
});

test("the rows a person approved in Extract data become a transaction list, and a CSV's rows again", () => {
	const rows = [{ date: "2026-10-01", description: "METRO", amount: "-45.10", balance: "954.90" }, { date: "2026-10-02", description: "DEPOSIT", amount: "100", balance: "" }];
	const data = viaJson(rowsData(rows, { currency: "CAD", approvedBy: "pat" }));
	assert.equal(data.type, "transactions");
	assert.deepEqual(data.transactions, [{ date: "2026-10-01", description: "METRO", amount_cents: -4510, balance_cents: 95490 }, { date: "2026-10-02", description: "DEPOSIT", amount_cents: 10000 }]);
	assert.equal(data.categorizer.approved_by, "pat");
	assert.deepEqual(rowsFromData(data), [{ date: "2026-10-01", description: "METRO", amount: "-45.10", balance: "954.90" }, { date: "2026-10-02", description: "DEPOSIT", amount: "100.00", balance: "" }]);
	// Exact: no floats.
	assert.equal(decimalToCents("1234567890.12"), 123456789012n);
	assert.equal(decimalToCents("-0.07"), -7n);
	assert.equal(decimalToCents("1.234"), null);
	assert.equal(centsToDecimal(-7), "-0.07");
	// Staged as a statement straight from them.
	assert.deepEqual(parsedFromExtraction(data).transactions.map((t) => t.amount_cents), [-4510n, 10000n]);
});

test("an approved bill is saved under the shared keys, and read back without the AI", () => {
	const bill = { kind: "bill", vendor: "Hydro One", invoice_number: "INV-9", bill_date: "2026-10-01", due_date: "2026-10-20", currency: "CAD", amount_cents: 8550n, vendor_entity_id: 4n, confidence: 0.9, summary: "October power" };
	const items = [{ description: "Delivery", quantity: "1", unit: "each", rate_cents: 3550n, amount_cents: 3550n }, { description: "Energy", quantity: "500", unit: "kwh", rate_cents: 10n, amount_cents: 5000n }];
	const data = viaJson(JSON.parse(JSON.stringify(billData(bill, items), (_k, v) => (typeof v === "bigint" ? Number(v) : v))));
	assert.deepEqual({ type: data.type, vendor: data.vendor, number: data.number, date: data.date, due_date: data.due_date, total_cents: data.total_cents, entity_id: data.entity_id }, { type: "bill", vendor: "Hydro One", number: "INV-9", date: "2026-10-01", due_date: "2026-10-20", total_cents: 8550, entity_id: 4 });
	assert.deepEqual(data.items[1], { description: "Energy", quantity: 500, unit: "kwh", rate_cents: 10, amount_cents: 5000 });
	const x = billFromData(data);
	assert.deepEqual({ kind: x.kind, vendor: x.vendor, invoice_number: x.invoice_number, bill_date: x.bill_date, due_date: x.due_date, amount_cents: x.amount_cents, currency: x.currency }, { kind: "bill", vendor: "Hydro One", invoice_number: "INV-9", bill_date: "2026-10-01", due_date: "2026-10-20", amount_cents: 8550n, currency: "CAD" });
	assert.deepEqual(x.items.map((it) => [it.description, it.quantity, it.unit, it.rate_cents, it.amount_cents]), [["Delivery", "1", "each", 3550n, 3550n], ["Energy", "500", "kwh", 10n, 5000n]]);
	// A field the bill doesn't have is null, which takes an older value off the document.
	assert.equal(billData({ ...bill, due_date: null }).due_date, null);
	// A statement's or a customer invoice's data isn't a bill; nor is something with neither vendor nor total.
	assert.equal(billFromData({ type: "statement", transactions: [] }), null);
	assert.equal(billFromData({ type: "invoice", customer: "Acme", total_cents: 100 }), null);
	assert.equal(billFromData({ type: "receipt" }), null);
	assert.equal(billFromData({ type: "receipt", vendor: "Cafe", total_cents: 450 }).kind, "receipt");
});

test("what a statement says is owed: saved and read back", () => {
	const owed = billInfoData({ vendor: "RBC Visa", statement_date: "2026-10-31", due_date: "2026-11-21", amount_cents: "51234", minimum_cents: "1000", reference: "4411", currency: "CAD", from: "person" });
	assert.deepEqual(owed.data, { vendor: "RBC Visa", date: "2026-10-31", due_date: "2026-11-21", total_cents: 51234, number: "4411", currency: "CAD" });
	const info = billInfoFromData(viaJson({ ...owed.data, categorizer: owed.mine }));
	assert.deepEqual({ from: info.from, due_date: info.due_date, amount_cents: info.amount_cents, minimum_cents: info.minimum_cents, reference: info.reference }, { from: "person", due_date: "2026-11-21", amount_cents: "51234", minimum_cents: "1000", reference: "4411" });
	assert.equal(billInfoFromData({ type: "statement", transactions: [] }), null);
	assert.equal(billInfoData({}), null);
});

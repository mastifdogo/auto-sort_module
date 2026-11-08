import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCents } from "../lib/categorize.mjs";
import { billCandidates, findBillEntryMatches, matchRequest, rowCandidates } from "../lib/matching.mjs";

const entry = (id, date, description, lines, extra = {}) => ({ id, entry_date: date, description, reference: "", reverses_id: null, reversed_by_id: null, links: [], lines, ...extra });
const line = (account_code, debit, credit) => ({ account_code, debit_cents: debit, credit_cents: credit });

test("bills already in the journal: exact amount in the bill's window, not linked by this module, not reversed", () => {
	const bills = [
		{ id: 1, kind: "bill", vendor: "Rogers", amount_cents: 8550n, bill_date: "2026-03-03", due_date: "2026-03-20" },
		{ id: 2, kind: "receipt", vendor: "Amazon", amount_cents: 2345n, bill_date: "2026-03-18", due_date: null },
		{ id: 3, kind: "bill", vendor: "Bell", amount_cents: null, bill_date: "2026-03-01", due_date: null },
	];
	const entries = [
		entry(10, "2026-03-19", "Rogers wireless", [line("5300", 8550, 0), line("1000", 0, 8550)]),
		entry(11, "2026-03-19", "Rogers again", [line("5300", 8550, 0), line("1000", 0, 8550)], { links: [{ module_id: "categorizer", ref: "tx:1" }] }),
		entry(12, "2026-03-18", "Amazon order", [line("5900", 2345, 0), line("2000", 0, 2345)], { reversed_by_id: 13 }),
		entry(14, "2026-06-01", "Amazon order", [line("5900", 2345, 0), line("2000", 0, 2345)]), // too late for a receipt
	];
	const found = findBillEntryMatches(bills, entries, "categorizer");
	assert.deepEqual(found.map((p) => [p.bill.id, p.entry.id]), [[1, 10]]);
	assert.ok(found[0].score > 0.8);
});

test("row candidates: entries on the row's account, duplicates, the other side of a transfer, bills; closest first", () => {
	const row = { id: 1, statement_id: 1, account_code: "1000", date: "2026-03-10", amount_cents: -5000n };
	const entries = [
		entry(20, "2026-03-11", "Transfer to savings", [line("1100", 5000, 0), line("1000", 0, 5000)]),
		entry(21, "2026-03-11", "Other account", [line("5900", 5000, 0), line("2000", 0, 5000)]), // not on 1000
		entry(22, "2026-04-30", "Too far", [line("5900", 5000, 0), line("1000", 0, 5000)]),
	];
	const rows = [
		{ id: 2, statement_id: 2, account_code: "1100", date: "2026-03-12", description: "FROM CHEQUING", amount_cents: 5000n, status: "new" },
		{ id: 3, statement_id: 3, account_code: "1000", date: "2026-03-10", description: "TFR", amount_cents: -5000n, status: "new" },
		{ id: 4, statement_id: 1, account_code: "1000", date: "2026-03-10", description: "same statement", amount_cents: -5000n, status: "new" },
		{ id: 5, statement_id: 4, account_code: "1100", date: "2026-03-10", description: "wrong sign", amount_cents: -5000n, status: "new" },
	];
	const bills = [{ id: 7, kind: "bill", status: "open", vendor: "Landlord", invoice_number: "", amount_cents: 5000n, due_date: "2026-03-09", bill_date: null }];
	const c = rowCandidates(row, { entries, rows, bills }, "categorizer");
	assert.deepEqual(c.map((x) => x.id), ["t3", "e20", "b7", "t2"]);
	assert.equal(c.find((x) => x.id === "t2").detail, "line on account 1100 (a transfer?)");
	assert.deepEqual(rowCandidates({ ...row, amount_cents: 5000n }, { bills }, "categorizer"), []); // money in doesn't pay bills
});

test("bill candidates: unposted payments and journal entries with the bill's amount", () => {
	const bill = { id: 1, kind: "bill", amount_cents: 12000n, bill_date: "2026-03-25", due_date: "2026-04-10" };
	const rows = [{ id: 9, account_code: "1000", date: "2026-04-09", description: "HYDRO", amount_cents: -12000n }, { id: 10, account_code: "1000", date: "2026-09-01", description: "late", amount_cents: -12000n }];
	const entries = [entry(30, "2026-04-08", "Hydro", [line("5400", 12000, 0), line("1000", 0, 12000)])];
	assert.deepEqual(billCandidates(bill, { rows, entries }, "categorizer").map((c) => c.id).sort(), ["e30", "t9"]);
	assert.deepEqual(billCandidates({ ...bill, amount_cents: null }, { rows, entries }, "categorizer"), []);
});

test("the LLM request lists items and candidates; answers are limited to the candidates' ids", () => {
	const req = matchRequest(
		[
			{ i: 1, item: { date: "2026-03-10", description: "TFR", amount_cents: -5000n }, candidates: [{ id: "e20", date: "2026-03-11", description: "Transfer", amount_cents: -5000n, detail: "journal entry #20" }] },
			{ i: 2, item: { date: "2026-03-12", description: "X", amount_cents: -100n }, candidates: [{ id: "t3", date: "2026-03-12", description: "X", amount_cents: -100n, detail: "line" }] },
		],
		formatCents,
	);
	assert.deepEqual(req.schema.properties.results.items.properties.match.enum, ["e20", "t3", ""]);
	assert.match(req.prompt, /Item 1: .*"amount":"-50.00"/);
	assert.match(req.prompt, /candidate e20: /);
});

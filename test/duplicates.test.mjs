import assert from "node:assert/strict";
import { test } from "node:test";
import { duplicateScore, findDuplicatePairs, findEntryDuplicates, pairKey, similarity } from "../lib/duplicates.mjs";

const row = (id, statement_id, date, description, amount, extra = {}) => ({
	id, statement_id, account_code: "1000", date, description, amount_cents: BigInt(amount), status: "new", chosen_code: null, bill_id: null, transfer_tx_id: null, transfer_entry_id: null, ...extra,
});

test("similar descriptions, close dates and the exact amount make a duplicate", () => {
	assert.equal(similarity("PETSMART #4411 TORONTO", "Petsmart Toronto"), 1);
	assert.equal(duplicateScore(row(1, 1, "2026-03-01", "SHELL 123", -4000), row(2, 2, "2026-03-01", "SHELL OIL", -4000)), 0.99);
	assert.equal(duplicateScore(row(1, 1, "2026-03-01", "SHELL", -4000), row(2, 2, "2026-03-02", "SHELL CANADA", -4000)), 0.85); // pending, then posted
	assert.equal(duplicateScore(row(1, 1, "2026-03-01", "SHELL", -4000), row(2, 2, "2026-03-01", "TIM HORTONS", -4000)), 0.7); // same day, same amount
	assert.equal(duplicateScore(row(1, 1, "2026-03-01", "SHELL", -4000), row(2, 2, "2026-03-03", "TIM HORTONS", -4000)), 0); // days apart, different payee
	assert.equal(duplicateScore(row(1, 1, "2026-03-01", "SHELL", -4000), row(2, 2, "2026-03-01", "SHELL", -4001)), 0);
	assert.equal(duplicateScore(row(1, 1, "2026-03-01", "SHELL", -4000), row(2, 2, "2026-03-05", "SHELL", -4000)), 0);
});

test("pairs: never on the same statement, never two posted rows, the posted (or worked-on, or older) row is kept", () => {
	const rows = [
		row(1, 1, "2026-03-01", "SHELL 123", -4000, { status: "posted" }),
		row(2, 2, "2026-03-01", "SHELL 123", -4000),
		row(3, 1, "2026-03-05", "COFFEE", -350),
		row(4, 1, "2026-03-05", "COFFEE", -350), // a real repeat on one statement
		row(5, 2, "2026-03-10", "NETFLIX", -1699),
		row(6, 3, "2026-03-10", "NETFLIX.COM", -1699, { chosen_code: "5200" }),
		row(7, 3, "2026-03-20", "RENT", -150000, { status: "posted" }),
		row(8, 4, "2026-03-20", "RENT", -150000, { status: "posted" }),
	];
	const pairs = findDuplicatePairs(rows);
	assert.deepEqual(pairs.map((p) => [p.keep.id, p.merge.id]), [[1, 2], [6, 5]]);
	assert.deepEqual(findDuplicatePairs(rows, new Set([pairKey(2, 1)])).map((p) => [p.keep.id, p.merge.id]), [[6, 5]]);
});

test("each row is in one pair at most; the two sides of a transfer aren't duplicates", () => {
	const rows = [row(1, 1, "2026-03-01", "SHELL", -4000), row(2, 2, "2026-03-01", "SHELL", -4000), row(3, 3, "2026-03-02", "SHELL", -4000)];
	assert.equal(findDuplicatePairs(rows).length, 1);
	const transfer = [row(1, 1, "2026-03-01", "TRANSFER", -4000, { transfer_tx_id: 2 }), row(2, 2, "2026-03-01", "TRANSFER", -4000, { transfer_tx_id: 1 })];
	assert.equal(findDuplicatePairs(transfer).length, 0);
});

test("entries in the journal: the same signed amount, not posted by this module", () => {
	const rows = [row(1, 1, "2026-03-01", "HYDRO ONE", -12000), row(2, 1, "2026-03-04", "PAYROLL", 200000), row(3, 1, "2026-03-01", "SHELL", -4000, { transfer_entry_id: 9 })];
	const lines = [
		{ journal_entry_id: 11, entry_date: "2026-03-02", description: "Hydro One bill", debit_cents: 0, credit_cents: 12000 },
		{ journal_entry_id: 12, entry_date: "2026-03-04", description: "Payroll", debit_cents: 0, credit_cents: 200000 }, // wrong sign
		{ journal_entry_id: 13, entry_date: "2026-03-01", description: "Shell", debit_cents: 0, credit_cents: 4000 },
		{ journal_entry_id: 14, entry_date: "2026-03-01", description: "Hydro One", debit_cents: 0, credit_cents: 12000 },
	];
	const found = findEntryDuplicates(rows, lines, new Set(["14"]));
	assert.deepEqual(found.map((p) => [p.merge.id, p.entry.id]), [[1, 11]]);
	assert.equal(found[0].entry.amount_cents, -12000n);
	assert.deepEqual(findEntryDuplicates(rows, lines, new Set(["14"]), new Set(["1-11"])), []);
});

test("a recheck also pairs two posted copies (never the same entry); the older one is kept", () => {
	const rows = [
		row(1, 1, "2026-03-01", "SHELL 123", -4000, { status: "posted", journal_entry_id: 10 }),
		row(2, 2, "2026-03-01", "SHELL 123", -4000, { status: "posted", journal_entry_id: 11 }),
		row(3, 3, "2026-03-05", "RENT", -150000, { status: "posted", journal_entry_id: 12 }),
		row(4, 4, "2026-03-05", "RENT", -150000, { status: "posted", journal_entry_id: 12 }),
	];
	assert.deepEqual(findDuplicatePairs(rows), []);
	const pairs = findDuplicatePairs(rows, new Set(), { includePosted: true });
	assert.deepEqual(pairs.map((p) => [p.keep.id, p.merge.id, p.both_posted]), [[1, 2, true]]);
});

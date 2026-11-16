import { test } from "node:test";
import assert from "node:assert/strict";
import { markAmended, netOn } from "../lib/ledger-sync.mjs";

const entry = (amended, bank) => ({ amended, lines: [{ account_code: "1000", debit_cents: 0, credit_cents: bank }, { account_code: "5900", debit_cents: bank, credit_cents: 0 }] });
const ctxWith = (entries) => ({ ledger: { getJournalEntry: async (id) => entries[id] ?? null } });

test("netOn adds debits and subtracts credits on one account", () => {
	assert.equal(netOn(entry(false, 999), "1000"), -999n);
	assert.equal(netOn(entry(false, 999), "5900"), 999n);
	assert.equal(netOn(null, "1000"), 0n);
});

test("markAmended flags only changed entries whose amount differs", async () => {
	const rows = [
		{ journal_entry_id: 1, amount_cents: -999n },
		{ journal_entry_id: 2, amount_cents: -500n },
		{ journal_entry_id: 3, amount_cents: -700n },
		{ journal_entry_id: null, amount_cents: -1n },
	];
	await markAmended(ctxWith({ 1: entry(true, 1099), 2: entry(false, 600), 3: entry(true, 700) }), rows, "1000");
	assert.equal(rows[0].entry_amended, true);
	assert.equal(rows[0].entry_amount_cents, -1099n);
	assert.equal(rows[1].entry_amended, undefined, "not changed by a person");
	assert.equal(rows[2].entry_amended, undefined, "changed, but the bank line is the same");
	assert.equal(rows[3].entry_amended, undefined);
});

test("markAmended with a sign (a bill's payable entry credits the account)", async () => {
	const ap = { amended: true, lines: [{ account_code: "2100", debit_cents: 0, credit_cents: 8000 }] };
	const [b] = await markAmended(ctxWith({ 9: ap }), [{ journal_entry_id: 9, amount_cents: 7500 }], "2100", { sign: -1n });
	assert.equal(b.entry_amount_cents, 8000n);
});

test("markAmended notes a changed entry date, even when the amounts are the same", async () => {
	const e = { amended: false, entry_date: "2026-03-08", lines: [{ account_code: "1000", debit_cents: 0, credit_cents: 999 }] };
	const rows = [{ journal_entry_id: 4, amount_cents: -999n, date: "2026-03-06" }, { journal_entry_id: 5, amount_cents: -1n, date: "2026-03-08" }];
	await markAmended({ ledger: { getJournalEntry: async (id) => (id === "4" ? e : { ...e, lines: [{ account_code: "1000", debit_cents: 0, credit_cents: 1 }] }) } }, rows, "1000");
	assert.equal(rows[0].entry_date_changed, true);
	assert.equal(rows[0].entry_date, "2026-03-08");
	assert.equal(rows[0].entry_amended, undefined);
	assert.equal(rows[1].entry_date_changed, undefined);
});

test("markAmended counts a line moved off the account (Unreconciled) as a change", async () => {
	const e = { amended: false, moves: [{ id: 1 }], entry_date: "2026-03-06", lines: [{ account_code: "1990", debit_cents: 0, credit_cents: 999 }] };
	const [r] = await markAmended({ ledger: { getJournalEntry: async () => e } }, [{ journal_entry_id: 1, amount_cents: -999n, date: "2026-03-06" }], "1000");
	assert.equal(r.entry_amended, true);
	assert.equal(r.entry_amount_cents, 0n);
});

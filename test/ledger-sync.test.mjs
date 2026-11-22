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

test("a bill's payable line in its vendor's own account isn't a changed amount (Ledger 0.31.0)", async () => {
	const { payableCodes, payableLineAccount, sameControl, isPayable, isReceivable } = await import("../lib/payables.mjs");
	const accounts = new Map([
		["2000", { code: "2000", type: "liability", kind: "payable", entity: null }],
		["2000-7", { code: "2000-7", type: "liability", kind: null, parent_code: "2000", entity: { id: 7, name: "Hydro One", role: "vendor" } }],
		["2000-9", { code: "2000-9", type: "liability", kind: null, parent_code: "2000", entity: { id: 9, name: "Bell", role: "vendor" } }],
		["2100", { code: "2100", type: "liability", kind: null, entity: null }],
		["1200", { code: "1200", type: "asset", kind: "receivable", entity: null }],
		["1200-4", { code: "1200-4", type: "asset", kind: null, parent_code: "1200", entity: { id: 4, name: "Acme", role: "customer" } }],
		["5100", { code: "5100", type: "expense", kind: null, entity: null }],
	]);
	// Moved by Ledger's update from accounts payable into the vendor's account: same amount, another account.
	const moved = { amended: false, moves: [{}], lines: [{ account_code: "5100", debit_cents: 8000, credit_cents: 0 }, { account_code: "2000-7", debit_cents: 0, credit_cents: 8000 }] };
	const rows = [{ journal_entry_id: 9, amount_cents: 8000, ap_account: "2000" }];
	await markAmended(ctxWith({ 9: moved }), rows, (b, e) => payableCodes(e, accounts, b.ap_account), { sign: -1n });
	assert.equal(rows[0].entry_amended, undefined);
	assert.equal(netOn(moved, new Set(["2000", "2000-7"])), -8000n);
	// A person changed the amount: still flagged, wherever the line is.
	const changed = { ...moved, amended: true, lines: [{ account_code: "5100", debit_cents: 9000, credit_cents: 0 }, { account_code: "2000-7", debit_cents: 0, credit_cents: 9000 }] };
	const [b] = await markAmended(ctxWith({ 9: changed }), [{ journal_entry_id: 9, amount_cents: 8000, ap_account: "2000" }], (r, e) => payableCodes(e, accounts, r.ap_account), { sign: -1n });
	assert.equal(b.entry_amount_cents, 9000n);
	// Where the payable line sits: the vendor's own account, else the account the bill went through.
	assert.equal(payableLineAccount(moved, accounts, "2000"), "2000-7");
	assert.equal(payableLineAccount({ lines: [{ account_code: "2100", debit_cents: 0, credit_cents: 8000 }] }, accounts, "2100"), "2100", "an account chosen under Settings, not tagged");
	assert.equal(payableLineAccount({ lines: [{ account_code: "5100", debit_cents: 0, credit_cents: 8000 }] }, accounts, "2000"), null, "moved somewhere else by hand");
	assert.equal(payableLineAccount({ lines: [{ account_code: "2000-7", debit_cents: 8000, credit_cents: 0 }] }, accounts, "2000"), null, "a debit isn't the bill's line");
	// Booking a payment: accounts payable and the vendor's account under it are the same payables; two vendors' aren't.
	assert.equal(sameControl("2000", "2000-7", accounts), true);
	assert.equal(sameControl("2000-7", "2000-7", accounts), true);
	assert.equal(sameControl("2000-9", "2000-7", accounts), false);
	assert.equal(sameControl("1200", "1200-4", accounts), true);
	assert.equal(sameControl("1200", "2000-7", accounts), false);
	assert.equal(sameControl("5100", "2000-7", accounts), false);
	assert.equal(sameControl("2100", "2100", accounts), true);
	assert.deepEqual([isPayable(accounts.get("2000-7")), isPayable(accounts.get("2100")), isReceivable(accounts.get("1200-4")), isReceivable(accounts.get("2000"))], [true, false, true, false]);
});

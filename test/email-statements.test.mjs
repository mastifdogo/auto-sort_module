import assert from "node:assert/strict";
import { test } from "node:test";
import { extractPdfStatement, shouldFlip } from "../lib/email-statements.mjs";

test("card CSVs with purchases as positive amounts are flipped", () => {
	const card = { type: "liability" };
	const parsed = { format: "csv", transactions: [{ amount_cents: 500n }, { amount_cents: 1200n }, { amount_cents: -3000n }] };
	assert.equal(shouldFlip(card, parsed), true);
	assert.equal(shouldFlip({ type: "asset" }, parsed), false);
	assert.equal(shouldFlip(card, { ...parsed, format: "ofx" }), false);
	assert.equal(shouldFlip(null, parsed), false);
});

test("PDF statements are read by the AI into signed transactions", async () => {
	let sent;
	const llm = async (req) => {
		sent = req;
		return { data: { account_code: "2100", account_hint: "x4411", transactions: [
			{ date: "2026-03-04", description: "TIM HORTONS", amount: "-3.10" },
			{ date: "2026-03-10", description: "PAYMENT THANK YOU", amount: "250.00" },
			{ date: "bad", description: "junk", amount: "1" },
			{ date: "2026-03-11", description: "ZERO", amount: "0" },
		] } };
	};
	const accounts = [{ code: "1000", name: "Chequing", type: "asset" }, { code: "2100", name: "Visa", type: "liability" }];
	const email = { from: "Visa <st@card.ca>", subject: "Statement", text: "" };
	const r = await extractPdfStatement({ llm, email, pdf: { filename: "march.pdf", data: Buffer.from("%PDF-1.4 x") }, accounts });
	assert.equal(r.account_code, "2100");
	assert.equal(r.account_hint, "4411");
	assert.deepEqual(r.transactions.map((t) => [t.date, t.description, t.amount_cents]), [["2026-03-04", "TIM HORTONS", -310n], ["2026-03-10", "PAYMENT THANK YOU", 25000n]]);
	assert.equal(sent.documents[0].media_type, "application/pdf");
	assert.deepEqual(sent.schema.properties.account_code.enum, ["1000", "2100", ""]);
	assert.match(sent.system, /purchase is negative/);
});


test("a PDF statement's balance is read in the same call as its transactions", async () => {
	const llm = async () => ({ data: { account_code: "", account_hint: "", transactions: [{ date: "2026-03-04", description: "TIM HORTONS", amount: "-3.10" }],
		balance: { vendor: "Visa", statement_date: "2026-03-05", due_date: "2026-03-28", amount_due: "1,234.56", minimum_payment: "10.00", reference: "4411", currency: "CAD" } } });
	const r = await extractPdfStatement({ llm, email: { from: "x", subject: "s", text: "" }, pdf: { filename: "m.pdf", data: Buffer.from("%PDF-1.4") }, accounts: [] });
	assert.deepEqual(r.balance, { vendor: "Visa", bill_date: "2026-03-05", due_date: "2026-03-28", amount_cents: 123456n, minimum_cents: 1000n, invoice_number: "4411", currency: "CAD" });
	// An answer without a balance (older connections) still works.
	const r2 = await extractPdfStatement({ llm: async () => ({ data: { account_code: "", account_hint: "", transactions: [] } }), email: { from: "x", subject: "s", text: "" }, pdf: { filename: "m.pdf", data: Buffer.from("%PDF-1.4") }, accounts: [] });
	assert.equal(r2.balance.amount_cents, null);
});

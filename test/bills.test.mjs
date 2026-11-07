import assert from "node:assert/strict";
import { test } from "node:test";
import { assignMatches, extractBill, findDuplicate, gmailQuery, looksLikeBill, matchScore } from "../lib/bills.mjs";
import { parseEmail } from "../lib/mime.mjs";
import { sampleEmail } from "./helpers.mjs";

const accounts = [
	{ code: "5300", name: "Phone & Internet", type: "expense" },
	{ code: "5400", name: "Utilities", type: "expense" },
];

test("keyword filter", () => {
	const e = parseEmail(sampleEmail());
	assert.ok(looksLikeBill(e, ["invoice", "amount due"]));
	assert.ok(!looksLikeBill({ ...e, subject: "Hello", text: "lunch?", attachments: [] }, ["invoice"]));
	assert.ok(looksLikeBill({ subject: "", from: "", text: "", attachments: [] }, []));
});

const ANSWER = { kind: "bill", vendor: "Rogers", invoice_number: "INV-9", bill_date: "2026-03-03", due_date: "2026-03-20", amount_due: "85.50", currency: "CAD", account_code: "5300", confidence: 0.9, summary: "March phone bill" };

test("extractBill passes the PDF to an AI that reads PDFs and parses the answer", async () => {
	let sent;
	const llm = async (req) => ((sent = req), { data: ANSWER });
	const email = parseEmail(sampleEmail());
	const x = await extractBill({ llm, readsPdf: true, email, pdfs: email.attachments, accounts, examples: [{ vendor: "Rogers", account_code: "5300" }] });
	assert.deepEqual(x, { kind: "bill", vendor: "Rogers", invoice_number: "INV-9", bill_date: "2026-03-03", due_date: "2026-03-20", amount_cents: 8550n, currency: "CAD", account_code: "5300", confidence: 0.9, summary: "March phone bill" });
	assert.equal(sent.documents.length, 1);
	assert.equal(sent.documents[0].media_type, "application/pdf");
	assert.equal(Buffer.from(sent.documents[0].data, "base64").toString("latin1").slice(0, 8), "%PDF-1.4");
	assert.match(sent.prompt, /"Rogers" -> 5300/);
	assert.match(sent.prompt, /Subject: Your Rogers bill/);
	assert.deepEqual(sent.schema.properties.account_code.enum, ["5300", "5400", ""]);
});

test("an AI that can't read PDFs gets the text and is told about the PDF", async () => {
	let sent;
	const llm = async (req) => ((sent = req), { data: { ...ANSWER, kind: "not_bill", amount_due: "" } });
	const email = parseEmail(sampleEmail());
	const x = await extractBill({ llm, readsPdf: false, email, pdfs: email.attachments, accounts });
	assert.equal(x.kind, "not_bill");
	assert.deepEqual(sent.documents, []);
	assert.match(sent.prompt, /Attached PDFs that you cannot see: Rogers March.pdf/);
});

test("duplicates: same invoice number, or same amount and due date", () => {
	const existing = [{ id: 1, vendor: "Rogers Communications", invoice_number: "INV-9", amount_cents: 8550n, due_date: "2026-03-20", bill_date: null }];
	assert.equal(findDuplicate({ vendor: "Rogers", invoice_number: "INV-9", amount_cents: 1n }, existing)?.id, 1);
	assert.equal(findDuplicate({ vendor: "Rogers", invoice_number: "INV-10", amount_cents: 8550n, due_date: "2026-03-20" }, existing), null);
	assert.equal(findDuplicate({ vendor: "ROGERS", invoice_number: "", amount_cents: 8550n, due_date: "2026-03-20" }, existing)?.id, 1);
	assert.equal(findDuplicate({ vendor: "Bell", invoice_number: "", amount_cents: 8550n, due_date: "2026-03-20" }, existing), null);
});

test("matching: exact amount out, date window, vendor bonus", () => {
	const bill = { id: 1, kind: "bill", vendor: "Rogers", amount_cents: 8550n, bill_date: "2026-03-03", due_date: "2026-03-20" };
	const tx = (date, description, amount) => ({ id: description, date, description, amount_cents: amount });
	assert.equal(matchScore(bill, tx("2026-03-20", "ROGERS WIRELESS PAP", -8550n)), 0.95);
	assert.equal(matchScore(bill, tx("2026-04-10", "PAYMENT 0042", -8550n)), 0.6);
	assert.equal(matchScore(bill, tx("2026-03-20", "ROGERS", 8550n)), 0); // money in
	assert.equal(matchScore(bill, tx("2026-03-20", "ROGERS", -8551n)), 0);
	assert.equal(matchScore(bill, tx("2026-06-01", "ROGERS", -8550n)), 0); // too late
	assert.equal(matchScore({ ...bill, vendor: "Toronto Hydro" }, tx("2026-03-21", "TORONTOHYDRO", -8550n)) > 0.8, true);

	const bills = [bill, { ...bill, id: 2, vendor: "Bell", due_date: "2026-03-25" }];
	const txs = [tx("2026-03-20", "ROGERS", -8550n), tx("2026-03-25", "BELL CANADA", -8550n)];
	const m = assignMatches(bills, txs).map((p) => [p.bill.id, p.tx.id]);
	assert.deepEqual(m.sort(), [[1, "ROGERS"], [2, "BELL CANADA"]]);
	assert.deepEqual(assignMatches(bills, txs, (b, t) => !(b.id === 1 && t.id === "ROGERS")).map((p) => [p.bill.id, p.tx.id]), [[2, "BELL CANADA"]]);
});

test("Gmail search for bills", () => {
	assert.equal(gmailQuery({ lookbackDays: 30, keywords: ["invoice", "amount due"], custom: "" }), 'newer_than:30d {invoice "amount due"}');
	assert.equal(gmailQuery({ lookbackDays: 7, keywords: ["invoice"], custom: "label:bills" }), "newer_than:7d label:bills");
	assert.equal(gmailQuery({ lookbackDays: 7, keywords: [], custom: "" }), "newer_than:7d");
});

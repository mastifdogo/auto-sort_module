import assert from "node:assert/strict";
import { test } from "node:test";
import { assignMatches, billInfoOf, draftFromBillInfo, extractBill, findDuplicate, imageType, matchScore, normalizeItem, readItems } from "../lib/bills.mjs";
import { parseOfx } from "../lib/parse.mjs";
import { parseEmail } from "../lib/mime.mjs";
import { sampleEmail } from "./helpers.mjs";

const accounts = [
	{ code: "5300", name: "Phone & Internet", type: "expense" },
	{ code: "5400", name: "Utilities", type: "expense" },
];

const ANSWER = { kind: "bill", vendor: "Rogers", invoice_number: "INV-9", bill_date: "2026-03-03", due_date: "2026-03-20", amount_due: "85.50", currency: "CAD", account_code: "5300", confidence: 0.9, summary: "March phone bill" };

test("extractBill passes the PDF to an AI that reads PDFs and parses the answer", async () => {
	let sent;
	const llm = async (req) => ((sent = req), { data: ANSWER });
	const email = parseEmail(sampleEmail());
	const x = await extractBill({ llm, readsPdf: true, email, pdfs: email.attachments, accounts, examples: [{ vendor: "Rogers", account_code: "5300" }] });
	assert.deepEqual(x, { kind: "bill", vendor: "Rogers", invoice_number: "INV-9", bill_date: "2026-03-03", due_date: "2026-03-20", amount_cents: 8550n, currency: "CAD", account_code: "5300", confidence: 0.9, summary: "March phone bill", items: [] });
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

test("pictures are recognised by their bytes", () => {
	assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])), "image/jpeg");
	assert.equal(imageType(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)])), "image/png");
	assert.equal(imageType(Buffer.from("GIF89a......")), "image/gif");
	assert.equal(imageType(Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 ", "latin1")), "image/webp");
	assert.equal(imageType(Buffer.from("%PDF-1.4 not a picture")), null);
	assert.equal(imageType(Buffer.from("tiny")), null);
});

test("photos of a receipt go to Ledger's LLM API as images, when a connection for images exists", async () => {
	const photo = { filename: "receipt.jpg", contentType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3, 4, 5, 6, 7, 8, 9]) };
	const email = { subject: "receipt.jpg", from: "", date: null, text: "", attachments: [photo] };
	const calls = [];
	const llm = async (req) => {
		calls.push(req);
		return { data: { kind: "receipt", vendor: "Cafe", invoice_number: "", bill_date: "2026-04-02", due_date: "", amount_due: "12.40", currency: "CAD", account_code: "", confidence: 0.8, summary: "" } };
	};
	const x = await extractBill({ llm, readsImages: true, email, images: [photo], accounts: [] });
	assert.equal(x.amount_cents, 1240n);
	assert.deepEqual(calls[0].images, [{ media_type: "image/jpeg", data: photo.data.toString("base64") }]);
	assert.match(calls[0].prompt, /Attached pictures .*receipt\.jpg \(included above\)/);
	await extractBill({ llm, readsImages: false, email, images: [photo], accounts: [] });
	assert.equal(calls[1].images, undefined);
	assert.match(calls[1].prompt, /pictures that you cannot see/);
});

test("a receipt's split: lines with amounts and accounts from the list", async () => {
	const { suggestSplit } = await import("../lib/bills.mjs");
	let sent;
	const llm = async (req) => ((sent = req), { data: { lines: [{ description: "Groceries", amount: "40.10", account_code: "5400" }, { description: "Paper towels", amount: "9.90", account_code: "9999" }, { description: "bad", amount: "x", account_code: "5300" }], total: "50.00", confidence: 0.8 } });
	const r = await suggestSplit({ llm, bill: { kind: "receipt", vendor: "Costco", amount_cents: 5000, currency: "CAD" }, document: { text: "MILK 4.10 ..." }, accounts });
	assert.deepEqual(r.lines, [{ description: "Groceries", amount_cents: 4010n, account_code: "5400" }, { description: "Paper towels", amount_cents: 990n, account_code: null }]);
	assert.equal(r.total_cents, 5000n);
	assert.match(sent.prompt, /Receipt from Costco, total 50.00 CAD/);
	assert.deepEqual(sent.schema.properties.lines.items.properties.account_code.enum, ["5300", "5400", ""]);
});

test("a statement's amount owed, never computed from transactions", async () => {
	const { readStatementBill } = await import("../lib/bills.mjs");
	let sent;
	const llm = async (req) => ((sent = req), { data: { vendor: "RBC Visa", statement_date: "2026-03-28", due_date: "2026-04-18", amount_due: "1,234.56", minimum_payment: "10.00", reference: "4411", currency: "CAD", confidence: 0.9, summary: "March" } });
	const r = await readStatementBill({ llm, document: { text: "NEW BALANCE $1,234.56" }, about: ["Statement file: visa.ofx"] });
	assert.equal(r.amount_cents, 123456n);
	assert.equal(r.minimum_cents, 1000n);
	assert.equal(r.due_date, "2026-04-18");
	assert.match(sent.system, /Never compute a balance/);
	assert.match(sent.prompt, /NEW BALANCE/);
});

test("extractBill keeps the line items it reads, cleaned up", async () => {
	const items = [
		{ description: "Copy paper", quantity: "3", unit: "box", unit_price: "8.50", amount: "25.50" },
		{ description: "Toner", quantity: "", unit: "", unit_price: "", amount: "60.00" },
		{ description: "Labour  ", quantity: "2.5", unit: "Hours", unit_price: "", amount: "200.00" },
		{ description: "", quantity: "1", unit: "", unit_price: "1", amount: "1" },
		{ description: "Note", quantity: "", unit: "", unit_price: "", amount: "" },
	];
	const llm = async () => ({ data: { ...ANSWER, items } });
	const x = await extractBill({ llm, email: parseEmail(sampleEmail()), accounts });
	assert.deepEqual(x.items, [
		{ description: "Copy paper", quantity: "3", unit: "box", rate_cents: 850n, amount_cents: 2550n },
		{ description: "Toner", quantity: "1", unit: "", rate_cents: 6000n, amount_cents: 6000n },
		{ description: "Labour", quantity: "2.5", unit: "hours", rate_cents: 8000n, amount_cents: 20000n },
	]);
	const none = await extractBill({ llm: async () => ({ data: { ...ANSWER, kind: "not_bill", items } }), email: parseEmail(sampleEmail()), accounts });
	assert.deepEqual(none.items, []);
});

test("normalizeItem: a price that doesn't divide stays empty, the quantity is kept", () => {
	assert.deepEqual(normalizeItem({ description: "Bolts", quantity: "3", unit: "", unit_price: "", amount: "1.00" }), { description: "Bolts", quantity: "3", unit: "", rate_cents: null, amount_cents: 100n });
	assert.equal(normalizeItem({ description: "Odd unit", quantity: "1", unit: "!!", unit_price: "2", amount: "" }).unit, "");
	assert.equal(normalizeItem({ description: "x".repeat(150), quantity: "1", unit: "", unit_price: "", amount: "" }).description.length, 100);
});

test("readItems asks for the items of the attached document", async () => {
	let sent;
	const llm = async (req) => ((sent = req), { data: { items: [{ description: "Gas", quantity: "40.123", unit: "litres", unit_price: "1.55", amount: "62.19" }] } });
	const items = await readItems({ llm, bill: { kind: "receipt", vendor: "Shell", amount_cents: 6219n, currency: "CAD" }, document: { text: "", pdf: Buffer.from("%PDF-1.4") } });
	assert.deepEqual(items, [{ description: "Gas", quantity: "40.123", unit: "litres", rate_cents: 155n, amount_cents: 6219n }]);
	assert.equal(sent.documents.length, 1);
	assert.match(sent.prompt, /Receipt from Shell, total 62.19 CAD/);
});

test("a statement's balance already read makes a bill draft without the LLM", () => {
	const card = { code: "2100", name: "Visa", type: "liability", currency: "CAD" };
	const info = billInfoOf({ vendor: "RBC Visa", bill_date: "2026-03-05", due_date: "2026-03-28", amount_cents: 123456n, minimum_cents: 1000n, invoice_number: "4411", currency: "CAD" }, "pdf");
	const d = draftFromBillInfo(JSON.parse(JSON.stringify(info)), { account: card, last: "2026-03-04" });
	assert.deepEqual(d, {
		kind: "bill", vendor: "RBC Visa", invoice_number: "4411", bill_date: "2026-03-05", due_date: "2026-03-28", amount_cents: 123456n, minimum_cents: 1000n,
		currency: "CAD", account_code: "2100", confidence: null, summary: "", read_from: "saved", saved_from: "pdf",
	});
	// Nothing read about the amount: the LLM is needed.
	assert.equal(billInfoOf({ vendor: "RBC" }, "pdf"), null);
	assert.equal(draftFromBillInfo(billInfoOf({ due_date: "2026-03-28" }, "pdf"), { account: card }), null);
	assert.equal(draftFromBillInfo(null, { account: card }), null);
});

test("an OFX balance owed on a card is a bill draft; on a bank account it isn't", () => {
	const ofx = "<OFX><CCSTMTRS><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260301<TRNAMT>-12.50<FITID>1<NAME>Coffee</STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>-845.20<DTASOF>20260305</LEDGERBAL><AVAILBAL><BALAMT>4000</AVAILBAL></CCSTMTRS></OFX>";
	const p = parseOfx(ofx);
	assert.deepEqual(p.balance, { amount_cents: -84520n, date: "2026-03-05" });
	const info = JSON.parse(JSON.stringify(billInfoOf({ balance_cents: p.balance.amount_cents, balance_date: p.balance.date }, "ofx")));
	const d = draftFromBillInfo(info, { account: { code: "2100", name: "Visa", type: "liability", currency: "CAD" }, last: "2026-03-01" });
	assert.equal(d.amount_cents, 84520n);
	assert.equal(d.bill_date, "2026-03-05");
	assert.equal(d.vendor, "Visa");
	assert.equal(draftFromBillInfo(info, { account: { code: "1000", name: "Chequing", type: "asset", currency: "CAD" } }), null);
	// A card in credit owes nothing.
	assert.equal(draftFromBillInfo({ ...info, balance_cents: "500" }, { account: { code: "2100", type: "liability" } }), null);
});

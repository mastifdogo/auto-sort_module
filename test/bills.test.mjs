import assert from "node:assert/strict";
import { test } from "node:test";
import { assignMatches, extractBill, findDuplicate, imageType, matchScore } from "../lib/bills.mjs";
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

import assert from "node:assert/strict";
import { test } from "node:test";
import { extractBill } from "../lib/bills.mjs";
import { accountHint, extractPdfStatement, senderAddress, shouldFlip, sourceKey, statementFiles } from "../lib/email-statements.mjs";
import { parseEmail } from "../lib/mime.mjs";

const OFX = `OFXHEADER:100\r\n\r\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><ACCTID>00123-4567</BANKACCTFROM><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260302<TRNAMT>-45.10<FITID>F1<NAME>SHELL</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260303<TRNAMT>2000.00<FITID>F2<NAME>PAYROLL</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

const mailWith = (attachments, subject = "Your March eStatement") =>
	Buffer.from(
		[
			"From: My Bank <alerts@mybank.ca>",
			`Subject: ${subject}`,
			"Message-ID: <st-1@mybank>",
			'Content-Type: multipart/mixed; boundary="b"',
			"",
			"--b",
			"Content-Type: text/plain",
			"",
			"Your statement for the account ending in 4567 is attached.",
			...attachments.flatMap(([name, type, body]) => ["--b", `Content-Type: ${type}; name="${name}"`, `Content-Disposition: attachment; filename="${name}"`, "Content-Transfer-Encoding: base64", "", Buffer.from(body).toString("base64")]),
			"--b--",
			"",
		].join("\r\n"),
	);

test("statement attachments are found and parsed; other attachments are not", () => {
	const email = parseEmail(mailWith([["march.qfx", "application/octet-stream", OFX], ["logo.png", "image/png", "PNG..."], ["notes.csv", "text/csv", "hello,world\n"]]));
	const files = statementFiles(email);
	assert.deepEqual(files.map((f) => [f.filename, f.parsed.format, f.parsed.transactions.length]), [["march.qfx", "ofx", 2]]);
	assert.equal(accountHint(files[0].text, email.subject, email.text), "4567");
	assert.equal(sourceKey(email.from, "4567"), "alerts@mybank.ca|4567");
	assert.equal(senderAddress("alerts@mybank.ca"), "alerts@mybank.ca");
	assert.equal(sourceKey("x@y.z", ""), "x@y.z|-");
});

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

test("with the option on, the bill reader can say an email is a statement", async () => {
	let sent;
	const llm = async (req) => ((sent = req), { data: { kind: "statement", vendor: "Visa", invoice_number: "", bill_date: "", due_date: "", amount_due: "", currency: "", account_code: "", confidence: 0.9, summary: "" } });
	const email = { from: "x", subject: "Your statement", text: "", date: null, attachments: [] };
	assert.equal((await extractBill({ llm, email, accounts: [], statements: true })).kind, "statement");
	assert.ok(sent.schema.properties.kind.enum.includes("statement"));
	assert.equal((await extractBill({ llm, email, accounts: [], statements: false })).kind, "not_bill"); // option off: never "statement"
	assert.ok(!sent.schema.properties.kind.enum.includes("statement"));
});

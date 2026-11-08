import assert from "node:assert/strict";
import { test } from "node:test";
import { htmlToText, parseEmail } from "../lib/mime.mjs";
import { PDF, sampleEmail } from "./helpers.mjs";

test("parseEmail: headers, quoted-printable text, attachments", () => {
	const e = parseEmail(sampleEmail({ subject: "Votre facture été" }));
	assert.equal(e.subject, "Votre facture été");
	assert.equal(e.from, "Rogers Billing <billing@rogers.com>");
	assert.equal(e.messageId, "abc@rogers.com");
	assert.equal(e.date.toISOString(), "2026-03-03T15:00:00.000Z");
	assert.equal(e.text, "Amount due: $85.50 — due March 20, 2026. Thanks.");
	assert.equal(e.attachments.length, 1);
	assert.equal(e.attachments[0].filename, "Rogers March.pdf");
	assert.equal(e.attachments[0].contentType, "application/pdf");
	assert.deepEqual(e.attachments[0].data, PDF);
});

test("HTML-only emails become readable text", () => {
	const raw = Buffer.from("Subject: x\r\nContent-Type: text/html\r\n\r\n<style>p{}</style><table><tr><td>Total</td><td>$1,234.00</td></tr></table><p>Due&nbsp;soon &amp; now</p>");
	assert.equal(parseEmail(raw).text, "Total\t$1,234.00\nDue soon & now");
	assert.equal(htmlToText("a<br>b&#233;"), "a\nbé");
});


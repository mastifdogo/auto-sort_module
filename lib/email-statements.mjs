// Bank and card statements found in email: their transactions are staged on
// the Statements tab for you to review and post (Settings: "Statements in
// email" → Stage). CSV/OFX/QFX attachments are parsed directly; PDF
// statements are read by Ledger's AI (only providers that read PDFs).

import { ParseError, parseAmount, parseDate, parseStatement } from "./parse.mjs";

const FILE_RE = /\.(csv|ofx|qfx|qbo)$/i;
const TYPE_RE = /^(text\/csv|application\/(csv|x-ofx|ofx|x-qfx|vnd\.intu\.qfx|x-qbo)|application\/vnd\.ms-excel)$/i;

/** Attachments that are statement files, parsed. [{ filename, parsed }] (unparseable ones are left out). */
export function statementFiles(email) {
	const out = [];
	for (const a of email.attachments) {
		if (!FILE_RE.test(a.filename) && !TYPE_RE.test(a.contentType)) continue;
		if (a.data.length > 2_000_000) continue;
		try {
			const parsed = parseStatement(a.data.toString("utf8"), { filename: a.filename });
			out.push({ filename: a.filename || `statement.${parsed.format}`, parsed, text: a.data.toString("utf8") });
		} catch (err) {
			if (!(err instanceof ParseError)) throw err;
		}
	}
	return out;
}

/** The sender's address, lower case: "Bank <alerts@bank.com>" -> "alerts@bank.com". */
export function senderAddress(from) {
	const m = /<([^>]+)>/.exec(String(from)) ?? /([^\s<>]+@[^\s<>]+)/.exec(String(from));
	return (m ? m[1] : String(from)).trim().toLowerCase();
}

/** The last 4 digits of the account number, from OFX <ACCTID> or text like "ending in 4411", "****4411", "x4411". */
export function accountHint(...texts) {
	for (const t of texts) {
		const s = String(t ?? "");
		const ofx = /<ACCTID>\s*([0-9 -]{4,})/i.exec(s);
		if (ofx) return ofx[1].replace(/\D/g, "").slice(-4);
		const m = /(?:ending(?: in)?|ends in|\*{2,}|x{2,}|#|account(?: number)?[: ]+[^\n\d]{0,12})\s*(\d{4})\b/i.exec(s);
		if (m) return m[1];
	}
	return "";
}

/** How statements from one sender for one account are remembered. */
export const sourceKey = (from, hint) => `${senderAddress(from)}|${hint || "-"}`;

/**
 * Card exports often show purchases as positive amounts. For a liability (card) account, a CSV
 * whose amounts are mostly positive is taken to be in that style and flipped. OFX states signs.
 */
export function shouldFlip(account, parsed) {
	if (!account || account.type !== "liability" || parsed.format !== "csv") return false;
	const pos = parsed.transactions.filter((t) => t.amount_cents > 0n).length;
	return pos / parsed.transactions.length > 0.6;
}

export function pdfStatementSchema(codes) {
	return {
		type: "object",
		properties: {
			account_code: { type: "string", enum: [...codes, ""] },
			account_hint: { type: "string", description: "last 4 digits of the account number, or empty" },
			transactions: {
				type: "array",
				items: {
					type: "object",
					properties: {
						date: { type: "string", description: "YYYY-MM-DD" },
						description: { type: "string" },
						amount: { type: "string", description: "signed decimal: negative = money out of the account, positive = money in" },
					},
					required: ["date", "description", "amount"],
					additionalProperties: false,
				},
			},
		},
		required: ["account_code", "account_hint", "transactions"],
		additionalProperties: false,
	};
}

const PDF_SYSTEM = `You read bank and credit-card statements for a bookkeeper and list every transaction on them.

- One entry per transaction line, in statement order. Leave out balances, subtotals, interest-rate tables and summaries.
- date: the transaction (or posting) date as YYYY-MM-DD; use the statement period to supply the year.
- description: the merchant or payee text as printed.
- amount: from the account holder's side. Negative = money out of the account (purchases, withdrawals, fees, cheques). Positive = money in (deposits, refunds, payments made to a credit card). On a credit-card statement a purchase is negative and a payment received is positive.
- account_code: the account from the list the statement is for, if its name, number or institution makes that clear; otherwise empty.
- account_hint: the last 4 digits of the account or card number, if shown.
Never invent transactions.`;

/**
 * Reads a PDF statement with Ledger's AI. accounts: the bank and card accounts (asset/liability).
 * Returns { account_code, account_hint, transactions: [{ line, date, description, memo, amount_cents, fitid }] }.
 */
export async function extractPdfStatement({ llm, email, pdf, accounts }) {
	const codes = accounts.map((a) => a.code);
	const prompt = [
		"Bank and card accounts (code | name | type | description):",
		...accounts.map((a) => `${a.code} | ${a.name} | ${a.type}${a.description ? ` | ${a.description.slice(0, 120)}` : ""}`),
		"",
		`From: ${email.from}`,
		`Subject: ${email.subject}`,
		`The statement is the attached PDF (${pdf.filename || "statement.pdf"}). List its transactions.`,
	].join("\n");
	const { data } = await llm({
		system: PDF_SYSTEM,
		prompt,
		schema: pdfStatementSchema(codes),
		maxTokens: 16000,
		documents: [{ media_type: "application/pdf", data: pdf.data.toString("base64"), name: pdf.filename }],
	});
	const transactions = [];
	for (const [i, t] of (Array.isArray(data?.transactions) ? data.transactions : []).entries()) {
		const date = parseDate(t?.date ?? "");
		const amount = parseAmount(t?.amount ?? "");
		if (!date || amount === null || amount === 0n) continue;
		transactions.push({ line: i + 1, date, description: String(t.description ?? "").trim().slice(0, 500) || "(no description)", memo: "", amount_cents: amount, fitid: "" });
	}
	return {
		account_code: codes.includes(data?.account_code) ? data.account_code : null,
		account_hint: String(data?.account_hint ?? "").replace(/\D/g, "").slice(-4),
		transactions,
	};
}

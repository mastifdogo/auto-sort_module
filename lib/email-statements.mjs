// Statements other modules send (and, before 0.6.0, statements found in email):
// account hints, how a sender's account is remembered, card sign conventions,
// and PDF statements read by Ledger's LLM API (connections that read PDFs).

import { parseAmount, parseDate } from "./parse.mjs";

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
			balance: {
				type: "object",
				description: "what the statement says is owed; empty strings where it doesn't say",
				properties: {
					vendor: { type: "string", description: "the bank or card's short name" },
					statement_date: { type: "string", description: "YYYY-MM-DD or empty" },
					due_date: { type: "string", description: "payment due date, YYYY-MM-DD or empty" },
					amount_due: { type: "string", description: "new balance / total owed as a decimal, or empty" },
					minimum_payment: { type: "string", description: "decimal or empty" },
					reference: { type: "string", description: "statement number or last digits of the account, or empty" },
					currency: { type: "string", enum: ["CAD", "USD", ""] },
				},
				required: ["vendor", "statement_date", "due_date", "amount_due", "minimum_payment", "reference", "currency"],
				additionalProperties: false,
			},
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
		required: ["account_code", "account_hint", "transactions", "balance"],
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
- balance: what the statement says is owed, so it can be tracked as a bill: the statement date, the payment due date, the new balance or total amount owed (amount_due, not the minimum payment), the minimum payment, a reference (statement number or account's last digits), the currency. Leave a field empty when the statement doesn't print it; never compute a balance from the transactions.
Never invent transactions.`;

/**
 * Reads a PDF statement with Ledger's AI. accounts: the bank and card accounts (asset/liability).
 * Returns { account_code, account_hint, transactions: [{ line, date, description, memo, amount_cents, fitid }],
 * balance: { vendor, bill_date, due_date, amount_cents, minimum_cents, invoice_number, currency } } (what is owed, read in the
 * same call, so Create bill needn't ask again).
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
		balance: {
			vendor: String(data?.balance?.vendor ?? "").trim().slice(0, 200),
			bill_date: parseDate(data?.balance?.statement_date ?? "") ?? null,
			due_date: parseDate(data?.balance?.due_date ?? "") ?? null,
			amount_cents: positive(data?.balance?.amount_due),
			minimum_cents: positive(data?.balance?.minimum_payment),
			invoice_number: String(data?.balance?.reference ?? "").trim().slice(0, 100),
			currency: ["CAD", "USD"].includes(data?.balance?.currency) ? data.balance.currency : "",
		},
	};
}

function positive(v) {
	const a = parseAmount(String(v ?? ""));
	return a !== null && a > 0n ? a : null;
}

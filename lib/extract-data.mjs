import { mapTags, withoutCode } from "./html.mjs";
// Extract data (the inbox's Send panel): a file that isn't a CSV (a PDF, a photo, a text statement)
// is read by the AI set under Settings → LLM API (ctx.llm). What it read is a suggestion a person
// checks and corrects; approved, it is saved with the document in Ledger (its extracted data) and
// the module uses it as a statement's lines. These are the pure parts: what is asked, and the
// checks on what comes back.

export const EXTRACT_MAX_BYTES = 30 * 1024 * 1024; // about what LLM APIs take as one PDF
export const EXTRACT_MAX_CHARS = 400_000; // ~100k tokens of text
const TEXT_EXT_RE = /\.(txt|text|ofx|qfx|qbo|html?|xml|json|tsv|eml|md|prn)$/i;
const TEXT_TYPE_RE = /^(text\/|application\/(json|xml|xhtml\+xml|x-ofx|vnd\.intu\.qfx|x-qfx)\b|message\/rfc822)/i;

export const EXTRACT_SYSTEM = `You extract financial transactions from bank statements, credit card statements, account activity exports, receipts and invoices so they can be imported into bookkeeping software.
Rules:
- One entry per transaction, in the order they appear. Skip opening/closing balance lines, subtotals, headers and page footers.
- date: the transaction (or posting) date as YYYY-MM-DD. Infer the year from the statement period when rows omit it.
- description: the payee or description as printed, on one line.
- amount: a plain decimal number with a dot and no thousands separators or currency symbol, e.g. "-42.10". Negative is money leaving the account (purchases, withdrawals, fees, payments made); positive is money coming in (deposits, refunds, credits). For a credit card statement, purchases are negative and payments to the card are positive.
- balance: the running balance after the transaction in the same format, or "" when the document doesn't show one.
- currency: the ISO 4217 code of the amounts (e.g. "CAD", "USD"), or "" if unknown.
- A receipt or invoice is one transaction: its total, negative, dated the purchase date, with the vendor as description.
- Never invent transactions. If there are none, return an empty list.`;

export const EXTRACT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["currency", "transactions"],
	properties: {
		currency: { type: "string" },
		transactions: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["date", "description", "amount", "balance"],
				properties: {
					date: { type: "string" },
					description: { type: "string" },
					amount: { type: "string" },
					balance: { type: "string" },
				},
			},
		},
	},
};

const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp)$/i;
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024; // per picture, what LLM APIs take
export const IMAGE_MAX_COUNT = 20; // ctx.llm takes at most 20 images per request

/** "csv", "pdf", "image", "text", or null when the file can't be read. */
export function extractKind(f) {
	const type = String(f.content_type || "").toLowerCase();
	if (/\.csv$/i.test(f.name) || /^text\/csv\b/.test(type)) return "csv";
	if (/\.pdf$/i.test(f.name) || /^application\/pdf\b/.test(type)) return "pdf";
	if (IMAGE_EXT_RE.test(f.name) || /^image\/(jpeg|png|gif|webp)\b/.test(type)) return "image";
	if (TEXT_EXT_RE.test(f.name) || TEXT_TYPE_RE.test(type)) return "text";
	return null;
}

/** The picture's media type from its first bytes (what ctx.llm accepts), or null. */
export function imageType(b) {
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (b[0] === 0x89 && b.subarray(1, 4).toString("latin1") === "PNG") return "image/png";
	if (b.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
	if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
	return null;
}

/**
 * The JPEG photos inside a PDF (DCTDecode image streams): a scanned receipt, such as the
 * Scan receipt tab makes, as pictures for an image model that can't read PDFs.
 */
export function pdfJpegs(bytes) {
	const text = bytes.toString("latin1"); // 1 char = 1 byte, so offsets match
	const out = [];
	const re = /<<((?:[^<>]|<<(?:[^<>]|<<[^<>]*>>)*>>)*)>>\s*stream\r?\n/g;
	let m;
	while ((m = re.exec(text)) && out.length <= IMAGE_MAX_COUNT) {
		const dict = m[1];
		if (!/\/Subtype\s*\/Image\b/.test(dict) || !/\/DCTDecode\b/.test(dict) || /\/Filter\s*\[[^\]]*\/\w+[^\]]*\/\w+/.test(dict)) continue;
		const start = m.index + m[0].length;
		const direct = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
		const end = direct ? start + Number(direct[1]) : text.indexOf("endstream", start);
		if (end <= start || end > bytes.length) continue;
		const jpeg = bytes.subarray(start, end);
		if (imageType(jpeg) === "image/jpeg") out.push(jpeg);
		re.lastIndex = end;
	}
	return out;
}

/** The file as text for the AI (HTML reduced to its text), or null if it's binary. */
export function readableText(bytes, name) {
	if (bytes.includes(0)) return null;
	let text = new TextDecoder("utf-8").decode(bytes);
	if ((text.match(/�/g) || []).length > text.length / 100) text = bytes.toString("latin1"); // not UTF-8: Windows-1252 statements
	text = text.replace(/^﻿/, "");
	if (/\.html?$/i.test(name) || /^\s*<(!doctype html|html)\b/i.test(text)) {
		// One pass over each tag (html.mjs): a saved page can come from an email, which is untrusted.
		text = mapTags(withoutCode(text), (t) => (/^<\/(tr|p|div|li|h\d|table)\s*>$|^<br\s*\/?>$/i.test(t) ? "\n" : /^<\/t[dh]\s*>$/i.test(t) ? "\t" : " "))
			.replace(/&nbsp;/g, " ")
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/&#(\d{1,8});/g, (all, n) => (Number(n) > 0 && Number(n) <= 0x10ffff && !(Number(n) >= 0xd800 && Number(n) <= 0xdfff) ? String.fromCodePoint(Number(n)) : all))
			.replace(/[ \t]*\n\s*/g, "\n")
			.replace(/[  ]{2,}/g, " ");
	}
	return text;
}

/** "1,234.5" / "(12.00)" / "$-3" -> "1234.50" / "-12.00" / "-3.00", or null. Exact: no floats. */
export function decimal(s) {
	let t = String(s ?? "").replace(/[\s,$€£¥]|[A-Z]{3}/g, "");
	let neg = false;
	const paren = /^\((.*)\)$/.exec(t);
	if (paren) [neg, t] = [true, paren[1]];
	if (t.endsWith("-")) [neg, t] = [true, t.slice(0, -1)]; // "12.00-"
	const m = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(t);
	if (!m) return null;
	if (m[1] === "-") neg = !neg;
	const whole = m[2].replace(/^0+(?=\d)/, "");
	const cents = (m[3] ?? "").padEnd(2, "0");
	const zero = /^0+$/.test(whole) && cents === "00";
	return `${neg && !zero ? "-" : ""}${whole}.${cents}`;
}

/** The AI's rows, checked: valid dates and amounts only. */
export function cleanTransactions(data) {
	const list = Array.isArray(data?.transactions) ? data.transactions : [];
	const out = [];
	for (const t of list) {
		const date = String(t?.date ?? "").trim();
		const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
		if (!m) continue;
		const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
		if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) continue;
		const amount = decimal(t?.amount);
		if (amount === null) continue;
		const description = String(t?.description ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
		const balance = t?.balance === "" || t?.balance == null ? "" : (decimal(t.balance) ?? "");
		out.push({ date, description, amount, balance });
	}
	return out;
}

/** Rows a person edited before approving: every row must be valid (422 names the first bad one). */
export function checkRows(list) {
	if (!Array.isArray(list) || list.length > 5000) throw new Error("rows must be a list of at most 5000 transactions");
	const ok = cleanTransactions({ transactions: list });
	if (ok.length !== list.length) {
		const i = list.findIndex((t) => cleanTransactions({ transactions: [t] }).length === 0);
		throw new Error(`row ${i + 1}: needs a real date (YYYY-MM-DD) and an amount such as -42.10`);
	}
	return ok;
}

/** Date,Description,Amount[,Balance] with quoting, and text cells guarded against spreadsheet formulas. */
export function toCsv(tx) {
	const withBalance = tx.some((t) => t.balance !== "");
	const cell = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
	const text = (s) => cell(s !== "" && "=+-@\t\r".includes(s[0]) ? "'" + s : s);
	const lines = [withBalance ? "Date,Description,Amount,Balance" : "Date,Description,Amount"];
	for (const t of tx) lines.push([t.date, text(t.description), t.amount, ...(withBalance ? [t.balance] : [])].join(","));
	return lines.join("\r\n") + "\r\n";
}

/** "May statement (1).pdf" -> "May-statement-1-extracted.csv": a name Ledger's CSV files accept. */
export function csvName(name) {
	const base = name.replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+|[-.]+$/g, "").slice(0, 100);
	return `${base || "file"}-extracted.csv`;
}

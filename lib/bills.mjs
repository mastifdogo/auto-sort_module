// Bills: reading them out of documents (saved emails, PDFs, pictures) with the LLM, spotting duplicates
// (reminders for the same bill), and matching them to statement transactions.

import { formatCents } from "./categorize.mjs";
import { parseAmount, parseDate } from "./parse.mjs";

const MAX_BODY_CHARS = 15_000;

/**
 * The picture type of a file (a photographed receipt or bill), by its bytes: image/jpeg, image/png,
 * image/gif or image/webp, or null. These are the types Ledger's LLM API takes (Ledger 0.11.2).
 */
export function imageType(data) {
	const b = Buffer.isBuffer(data) ? data : Buffer.from(data ?? []);
	if (b.length < 12) return null;
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (b.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
	if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
	return null;
}

/** One line item as the LLM lists it (description, how many, unit, price per unit, line total). */
const ITEM_SCHEMA = {
	type: "object",
	properties: {
		description: { type: "string", description: "the item as printed, a few words" },
		quantity: { type: "string", description: "how many, e.g. 2 or 1.5; empty when not printed" },
		unit: { type: "string", description: "unit of the quantity in one lower-case word (each, hours, kg, litres, km), or empty" },
		unit_price: { type: "string", description: "price per unit as a decimal, or empty" },
		amount: { type: "string", description: "the line's total as a decimal, or empty" },
	},
	required: ["description", "quantity", "unit", "unit_price", "amount"],
	additionalProperties: false,
};

const MAX_ITEMS = 100;

/**
 * One line item cleaned up (pure): { description, quantity (string, ≤ 4 decimals) | null, unit,
 * rate_cents (bigint) | null, amount_cents (bigint) | null }, or null when it has no description or
 * no number at all. A missing price per unit comes from the line total and the quantity (when it
 * divides to whole cents); with neither quantity nor price, the item is 1 at its total. Ledger's
 * rate items need a quantity or a rate, so every item kept has at least one.
 */
export function normalizeItem(raw) {
	const description = String(raw?.description ?? "").trim().replace(/\s+/g, " ").slice(0, 100);
	if (!description) return null;
	const qn = Number(String(raw?.quantity ?? "").trim().replace(/,/g, ""));
	let quantity = String(raw?.quantity ?? "").trim() !== "" && Number.isFinite(qn) && qn > 0 && qn < 1e12 ? Math.round(qn * 10000) / 10000 : null;
	const money = (v) => {
		const a = parseAmount(typeof v === "number" ? v.toFixed(2) : String(v ?? ""));
		return a === null ? null : a;
	};
	let rate = money(raw?.unit_price ?? raw?.rate);
	if (rate !== null && rate < 0n) rate = null;
	const amount = money(raw?.amount);
	if (rate === null && amount !== null && amount >= 0n) {
		if (quantity === null) {
			quantity = 1;
			rate = amount;
		} else {
			const r = Number(amount) / quantity;
			if (Math.abs(r - Math.round(r)) < 1e-6) rate = BigInt(Math.round(r));
		}
	}
	if (quantity === null && rate === null) return null;
	const unit = String(raw?.unit ?? "").trim().toLowerCase();
	return {
		description,
		quantity: quantity === null ? null : String(quantity),
		unit: /^[a-z][a-z0-9 ./_-]{0,19}$/.test(unit) ? unit : "",
		rate_cents: rate,
		amount_cents: amount ?? (rate !== null && quantity !== null ? BigInt(Math.round(Number(rate) * quantity)) : null),
	};
}

/** The line items of an answer, cleaned up (at most 100). */
export const normalizeItems = (list) => (Array.isArray(list) ? list : []).map(normalizeItem).filter(Boolean).slice(0, MAX_ITEMS);

export function extractionSchema(codes) {
	return {
		type: "object",
		properties: {
			kind: { type: "string", enum: ["bill", "receipt", "not_bill"] },
			vendor: { type: "string" },
			invoice_number: { type: "string" },
			bill_date: { type: "string", description: "YYYY-MM-DD or empty" },
			due_date: { type: "string", description: "YYYY-MM-DD or empty" },
			amount_due: { type: "string", description: "decimal, e.g. 123.45, or empty" },
			currency: { type: "string", enum: ["CAD", "USD", "other", ""] },
			account_code: { type: "string", enum: [...codes, ""] },
			confidence: { type: "number", description: "0 to 1" },
			summary: { type: "string", description: "one short line" },
			items: { type: "array", items: ITEM_SCHEMA, description: "the individual line items, in order; empty when none are shown" },
		},
		required: ["kind", "vendor", "invoice_number", "bill_date", "due_date", "amount_due", "currency", "account_code", "confidence", "summary", "items"],
		additionalProperties: false,
	};
}

const SYSTEM = `You read documents for a bookkeeper (saved emails, PDFs, photos of receipts) and pick out bills and receipts.

kind:
- "bill": the sender asks to be paid, or states an amount that will be charged or withdrawn (invoices, utility and phone bills, credit-card or loan statements with an amount due, upcoming pre-authorized debits).
- "receipt": confirms a payment already made (order confirmations, payment receipts).
- "not_bill": anything else (newsletters, marketing, shipping notices without an amount, account alerts, "your bill is ready" without the amount).

For bills and receipts:
- vendor: the business's short name as it would appear on a bank statement, e.g. "Rogers", "Toronto Hydro", "Amazon".
- amount_due: the total to pay (for statements, the statement balance or the amount that will be withdrawn, not the minimum payment unless it is the only amount). For receipts, the total paid.
- bill_date: the invoice or statement date; due_date: when payment is due or will be withdrawn. Use YYYY-MM-DD. Leave empty when not stated.
- account_code: the account from the list this cost should be booked to, following the user's past bills where the vendor matches. Empty if none fits.
- currency: from the document; "other" for currencies not listed.
- confidence: your probability that the vendor, amount and dates are all correct.
- items: every individual line item (product or service) printed on it, in order: description, quantity, unit, unit_price and the line's amount as printed. Leave out subtotals, taxes, tips, deposits, discounts shown as totals, and payment lines. Empty fields where the document doesn't show them; an empty list when it lists no items.
Use only what the email and attached documents say. Never guess an amount.`;

/**
 * Reads one bill or receipt (a saved email, a PDF or a picture, wrapped as an email). Returns { kind, vendor, invoice_number, bill_date, due_date, amount_cents, currency, account_code, confidence, summary, items }
 * (items: normalizeItem's, the document's individual line items).
 * pdfs: [{ filename, data: Buffer }]; accounts: [{ code, name, type }]; examples: [{ vendor, account_code }]
 */
export async function extractBill({ llm, readsPdf = false, readsImages = false, email, pdfs = [], images = [], accounts, examples = [] }) {
	const codes = accounts.map((a) => a.code);
	let body = email.text;
	const truncated = body.length > MAX_BODY_CHARS;
	if (truncated) body = body.slice(0, MAX_BODY_CHARS);
	const usePdfs = readsPdf ? pdfs : [];
	const useImages = readsImages ? images : [];
	const prompt = [
		"Accounts (code | name | type):",
		...accounts.map((a) => `${a.code} | ${a.name} | ${a.type}`),
		"",
		examples.length > 0 ? "The user's past bills (vendor -> account):" : "",
		...examples.slice(0, 40).map((e) => `${JSON.stringify(e.vendor)} -> ${e.account_code}`),
		"",
		`From: ${email.from}`,
		`Subject: ${email.subject}`,
		`Date: ${email.date ? email.date.toISOString().slice(0, 10) : "unknown"}`,
		pdfs.length > 0
			? usePdfs.length > 0
				? `Attached documents: ${usePdfs.map((p) => p.filename || "document.pdf").join(", ")} (included above).`
				: `Attached PDFs that you cannot see: ${pdfs.map((p) => p.filename || "document.pdf").join(", ")}. If the amount is only in them, use kind "bill" with an empty amount.`
			: "",
		images.length > 0
			? useImages.length > 0
				? `Attached pictures (photos or scans of the bill or receipt): ${useImages.map((p) => p.filename || "picture").join(", ")} (included above).`
				: `Attached pictures that you cannot see: ${images.map((p) => p.filename || "picture").join(", ")}. If the amount is only in them, use an empty amount.`
			: "",
		"",
		"Email body:",
		body || "(empty)",
		truncated ? "[body truncated]" : "",
	]
		.filter((l, i, a) => l !== "" || a[i - 1] !== "")
		.join("\n");
	const { data } = await llm({
		system: SYSTEM,
		prompt,
		schema: extractionSchema(codes),
		maxTokens: 4000,
		documents: usePdfs.map((p) => ({ media_type: "application/pdf", data: p.data.toString("base64"), name: p.filename })),
		...(useImages.length > 0 ? { images: useImages.map((p) => ({ media_type: p.contentType, data: p.data.toString("base64") })) } : {}),
	});
	const kind = ["bill", "receipt"].includes(data?.kind) ? data.kind : "not_bill";
	const amount = parseAmount(data?.amount_due ?? "");
	const c = Number(data?.confidence);
	return {
		kind,
		vendor: String(data?.vendor ?? "").trim().slice(0, 200),
		invoice_number: String(data?.invoice_number ?? "").trim().slice(0, 100),
		bill_date: parseDate(data?.bill_date ?? "") ?? null,
		due_date: parseDate(data?.due_date ?? "") ?? null,
		amount_cents: amount !== null && amount > 0n ? amount : null,
		currency: ["CAD", "USD"].includes(data?.currency) ? data.currency : data?.currency === "other" ? "other" : "",
		account_code: codes.includes(data?.account_code) ? data.account_code : null,
		confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5,
		summary: String(data?.summary ?? "").slice(0, 300),
		items: kind === "not_bill" ? [] : normalizeItems(data?.items),
	};
}

const ITEMS_SYSTEM = `You list the individual line items (products or services) printed on a bill or receipt for a bookkeeper.
For each: description, quantity, unit (one lower-case word: each, hours, kg, litres, km; empty if none), unit_price and the line's amount, as printed; empty fields where the document doesn't show them.
Leave out subtotals, taxes, tips, deposits, discounts shown as totals, and payment lines. An empty list when it lists no items. Never invent items or prices.`;

/**
 * Asks the LLM for the line items of a bill already read (for bills from before items were read,
 * or to read them again). document: { text, pdf?: Buffer, image?: { data, contentType } }.
 * Returns normalizeItem's list. Nothing is saved: the user edits and saves.
 */
export async function readItems({ llm, bill, document }) {
	const { data } = await llm({
		system: ITEMS_SYSTEM,
		prompt: [
			`${bill.kind === "receipt" ? "Receipt" : "Bill"} from ${bill.vendor || "unknown"}, total ${bill.amount_cents == null ? "unknown" : formatCents(BigInt(bill.amount_cents))} ${bill.currency}.`,
			document.pdf || document.image ? "The document is attached above." : "",
			document.text ? `Document text:\n${document.text.slice(0, 15_000)}` : "",
		]
			.filter(Boolean)
			.join("\n"),
		schema: { type: "object", properties: { items: { type: "array", items: ITEM_SCHEMA } }, required: ["items"], additionalProperties: false },
		maxTokens: 4000,
		...(document.pdf ? { documents: [{ media_type: "application/pdf", data: document.pdf.toString("base64"), name: "document.pdf" }] } : {}),
		...(document.image ? { images: [{ media_type: document.image.contentType, data: document.image.data.toString("base64") }] } : {}),
	});
	return normalizeItems(data?.items);
}

// ---------------------------------------------------------------------------
// Vendors, duplicates, matching
// ---------------------------------------------------------------------------

const VENDOR_NOISE = new Set(["INC", "LTD", "LLC", "CORP", "CO", "THE", "AND", "COM", "WWW", "CANADA", "LIMITED", "SERVICES", "BILLING", "PAYMENT", "PAYMENTS"]);

/** Distinctive words of a vendor name or bank description. */
export function nameTokens(s) {
	return new Set(
		String(s ?? "")
			.toUpperCase()
			.replace(/[^A-Z0-9 ]/g, " ")
			.split(/\s+/)
			.filter((w) => w.length >= 3 && !/\d/.test(w) && !VENDOR_NOISE.has(w)),
	);
}

/** Whether two names share a word ("TORONTOHYDRO" and "Toronto Hydro" do too). */
export const shareToken = (a, b) => {
	const tb = nameTokens(b);
	for (const t of nameTokens(a)) if (tb.has(t)) return true;
	// "TORONTOHYDRO" vs "Toronto Hydro"
	const ca = String(a ?? "").toUpperCase().replace(/[^A-Z]/g, "");
	const cb = String(b ?? "").toUpperCase().replace(/[^A-Z]/g, "");
	return ca.length >= 5 && cb.length >= 5 && (ca.includes(cb) || cb.includes(ca));
};

/** The existing bill this one repeats (a reminder, or the same bill sent twice), if any. */
export function findDuplicate(bill, existing) {
	return (
		existing.find((e) => {
			if (!shareToken(bill.vendor, e.vendor)) return false;
			if (bill.invoice_number && e.invoice_number) return bill.invoice_number === e.invoice_number;
			if (bill.amount_cents === null || e.amount_cents === null || BigInt(bill.amount_cents) !== BigInt(e.amount_cents)) return false;
			return (bill.due_date && bill.due_date === e.due_date) || (bill.bill_date && bill.bill_date === e.bill_date);
		}) ?? null
	);
}

const DAY = 86_400_000;
const days = (iso) => Date.parse(iso + "T00:00:00Z") / DAY;

/**
 * Bills and receipts like this one, for a person to compare before adding it: the same one
 * (findDuplicate), or close to it: the same amount within 14 days, or the same vendor with an
 * amount within 5% within 31 days, or the same vendor and invoice number. Best first, at most
 * `limit`; each with score (0..1) and same (true: findDuplicate would call it the same).
 */
export function findSimilarBills(bill, existing, limit = 3) {
	const dup = findDuplicate(bill, existing);
	const dateOf = (b) => b.bill_date || b.due_date || null;
	const out = [];
	for (const e of existing) {
		if (dup && e.id === dup.id) { out.push({ bill: e, score: 1, same: true }); continue; }
		const vendor = shareToken(bill.vendor, e.vendor);
		const a = bill.amount_cents == null ? null : BigInt(bill.amount_cents);
		const b = e.amount_cents == null ? null : BigInt(e.amount_cents);
		const d1 = dateOf(bill);
		const d2 = dateOf(e);
		const gap = d1 && d2 ? Math.abs(days(d1) - days(d2)) : null;
		let score = 0;
		if (vendor && bill.invoice_number && e.invoice_number && bill.invoice_number === e.invoice_number) score = 0.9;
		else if (a !== null && b !== null && a > 0n && a === b && (gap === null || gap <= 14)) score = vendor ? 0.85 : gap !== null && gap <= 3 ? 0.6 : 0.5;
		else if (vendor && a !== null && b !== null && a > 0n && b > 0n && (a > b ? a - b : b - a) * 20n <= a && gap !== null && gap <= 31) score = 0.55;
		if (score > 0) out.push({ bill: e, score, same: false });
	}
	return out.sort((x, y) => y.score - x.score).slice(0, limit);
}

/**
 * How well a statement transaction fits as the payment of a bill: 0 (no) to 0.95.
 * Needs the exact amount going out, within a window around the bill's dates.
 */
export function matchScore(bill, tx) {
	if (bill.amount_cents === null || bill.amount_cents === undefined) return 0;
	if (BigInt(tx.amount_cents) !== -BigInt(bill.amount_cents)) return 0;
	const anchor = bill.bill_date ?? bill.due_date ?? bill.mail_date ?? null;
	if (!anchor) return 0;
	const t = days(tx.date);
	const receipt = bill.kind === "receipt";
	const lo = days(bill.bill_date ?? bill.due_date ?? anchor) - (receipt ? 3 : 7);
	const hi = days(bill.due_date ?? bill.bill_date ?? anchor) + (receipt ? 10 : 45);
	if (t < lo || t > hi) return 0;
	let score = 0.6;
	if (shareToken(bill.vendor, tx.description)) score += 0.25;
	if (bill.due_date && Math.abs(t - days(bill.due_date)) <= 5) score += 0.1;
	return Math.min(score, 0.95);
}

/** One-to-one matching, best scores first. Returns [{ bill, tx, score }]. allow(bill, tx) can veto a pair. */
export function assignMatches(bills, txs, allow = () => true) {
	const pairs = [];
	for (const b of bills) for (const t of txs) {
		if (!allow(b, t)) continue;
		const s = matchScore(b, t);
		if (s > 0) pairs.push({ bill: b, tx: t, score: s });
	}
	pairs.sort((a, b) => b.score - a.score);
	const usedB = new Set();
	const usedT = new Set();
	const out = [];
	for (const p of pairs) {
		if (usedB.has(p.bill.id) || usedT.has(p.tx.id)) continue;
		usedB.add(p.bill.id);
		usedT.add(p.tx.id);
		out.push(p);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Splitting a receipt into lines, and a bill from a statement's balance
// ---------------------------------------------------------------------------

const SPLIT_SYSTEM = `You split a receipt or bill into the parts a bookkeeper books to different accounts.
Read the document's line items and group them by account from the list: e.g. groceries vs. household supplies, office supplies vs. meals. Taxes, tips, deposits and fees: add them to the line they belong to when it's clear, otherwise give them their own line (account_code empty if none fits).
- description: a few words for the group ("Groceries", "Printer paper and toner").
- amount: that group's total as a decimal, e.g. 12.40. The amounts must add up to the receipt's total.
- account_code: the account from the list, following the user's past choices; empty if none fits.
Use only what the document says. If you can't see individual items, return one line with the total.`;

export function splitSchema(codes) {
	return {
		type: "object",
		properties: {
			lines: {
				type: "array",
				items: {
					type: "object",
					properties: { description: { type: "string" }, amount: { type: "string" }, account_code: { type: "string", enum: [...codes, ""] } },
					required: ["description", "amount", "account_code"],
					additionalProperties: false,
				},
			},
			total: { type: "string", description: "the receipt's total as printed" },
			confidence: { type: "number" },
		},
		required: ["lines", "total", "confidence"],
		additionalProperties: false,
	};
}

/**
 * Asks the LLM for a receipt's split. document: { text, pdf?: Buffer, image?: { data, contentType } }.
 * Returns { lines: [{ description, amount_cents, account_code }], total_cents, confidence }.
 */
export async function suggestSplit({ llm, bill, document, accounts, examples = [] }) {
	const codes = accounts.map((a) => a.code);
	const prompt = [
		"Accounts (code | name | type):",
		...accounts.map((a) => `${a.code} | ${a.name} | ${a.type}`),
		"",
		examples.length ? "The user's past choices (vendor -> account):" : "",
		...examples.slice(0, 30).map((e) => `${JSON.stringify(e.vendor)} -> ${e.account_code}`),
		"",
		`${bill.kind === "receipt" ? "Receipt" : "Bill"} from ${bill.vendor || "unknown"}, total ${bill.amount_cents == null ? "unknown" : formatCents(BigInt(bill.amount_cents))} ${bill.currency}${bill.bill_date ? `, dated ${bill.bill_date}` : ""}.`,
		document.pdf || document.image ? "The document is attached above." : "",
		document.text ? `Document text:\n${document.text.slice(0, 15_000)}` : "",
	]
		.filter((l, i, a) => l !== "" || a[i - 1] !== "")
		.join("\n");
	const { data } = await llm({
		system: SPLIT_SYSTEM,
		prompt,
		schema: splitSchema(codes),
		maxTokens: 4000,
		...(document.pdf ? { documents: [{ media_type: "application/pdf", data: document.pdf.toString("base64"), name: "receipt.pdf" }] } : {}),
		...(document.image ? { images: [{ media_type: document.image.contentType, data: document.image.data.toString("base64") }] } : {}),
	});
	const lines = [];
	for (const l of Array.isArray(data?.lines) ? data.lines : []) {
		const a = parseAmount(String(l.amount ?? ""));
		if (a === null || a <= 0n) continue;
		lines.push({ description: String(l.description ?? "").trim().slice(0, 200), amount_cents: a, account_code: codes.includes(l.account_code) ? l.account_code : null });
	}
	const total = parseAmount(String(data?.total ?? ""));
	const c = Number(data?.confidence);
	return { lines, total_cents: total !== null && total > 0n ? total : null, confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5 };
}

const STATEMENT_BILL_SYSTEM = `You read a credit card, loan or other account statement and pull out what is owed, so it can be tracked as a bill.
- vendor: the bank or card's short name ("RBC Visa", "Amex").
- statement_date: the statement or closing date; due_date: the payment due date. YYYY-MM-DD, empty when not stated.
- amount_due: the new balance / total amount owed as a decimal (not the minimum payment). Empty when not stated.
- minimum_payment: the minimum payment due, or empty.
- reference: the last digits of the account number, or the statement number, or empty.
- currency: CAD or USD, or "" when not stated.
- confidence: your probability that amount_due and due_date are right.
Use only what the statement says. Never compute a balance from the transactions and never guess an amount.`;

export function statementBillSchema() {
	return {
		type: "object",
		properties: {
			vendor: { type: "string" },
			statement_date: { type: "string" },
			due_date: { type: "string" },
			amount_due: { type: "string" },
			minimum_payment: { type: "string" },
			reference: { type: "string" },
			currency: { type: "string", enum: ["CAD", "USD", ""] },
			confidence: { type: "number" },
			summary: { type: "string", description: "one short line" },
		},
		required: ["vendor", "statement_date", "due_date", "amount_due", "minimum_payment", "reference", "currency", "confidence", "summary"],
		additionalProperties: false,
	};
}

/** Asks the LLM what a statement says is owed. document: { text?, pdf? }; about: lines describing the statement. */
export async function readStatementBill({ llm, document, about }) {
	const { data } = await llm({
		system: STATEMENT_BILL_SYSTEM,
		prompt: [...about, "", document.pdf ? "The statement is attached above." : "", document.text ? `Statement file:\n${document.text.slice(0, 20_000)}` : "There's no statement file; only the summary above."].filter(Boolean).join("\n"),
		schema: statementBillSchema(),
		maxTokens: 2000,
		...(document.pdf ? { documents: [{ media_type: "application/pdf", data: document.pdf.toString("base64"), name: "statement.pdf" }] } : {}),
	});
	const amt = (s) => {
		const a = parseAmount(String(s ?? ""));
		return a !== null && a > 0n ? a : null;
	};
	const c = Number(data?.confidence);
	return {
		vendor: String(data?.vendor ?? "").trim().slice(0, 200),
		bill_date: parseDate(data?.statement_date ?? "") ?? null,
		due_date: parseDate(data?.due_date ?? "") ?? null,
		amount_cents: amt(data?.amount_due),
		minimum_cents: amt(data?.minimum_payment),
		invoice_number: String(data?.reference ?? "").trim().slice(0, 100),
		currency: ["CAD", "USD"].includes(data?.currency) ? data.currency : "",
		confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5,
		summary: String(data?.summary ?? "").slice(0, 300),
	};
}

// ---------------------------------------------------------------------------
// What a statement says is owed, kept once read (statements.bill_info)
// ---------------------------------------------------------------------------

const centsOrNull = (v) => {
	if (v === null || v === undefined || v === "") return null;
	try {
		return BigInt(v);
	} catch {
		return null;
	}
};

/**
 * What to keep in statements.bill_info (pure): the fields of a statement's balance that were
 * read (from: "pdf", "ofx", "module" or "llm"), amounts as strings, or null when nothing useful
 * was read. r: { vendor?, bill_date?, due_date?, amount_cents?, minimum_cents?, invoice_number?,
 * currency?, balance_cents?, balance_date?, confidence?, summary? }.
 */
export function billInfoOf(r, from) {
	if (!r) return null;
	const str = (v, max) => String(v ?? "").trim().slice(0, max);
	const amt = (v) => {
		const c = centsOrNull(v);
		return c === null ? null : c.toString();
	};
	const info = {
		from,
		vendor: str(r.vendor, 200),
		statement_date: parseDate(r.bill_date ?? r.statement_date ?? "") ?? null,
		due_date: parseDate(r.due_date ?? "") ?? null,
		amount_cents: amt(r.amount_cents),
		minimum_cents: amt(r.minimum_cents),
		reference: str(r.invoice_number ?? r.reference, 100),
		currency: ["CAD", "USD"].includes(r.currency) ? r.currency : "",
		balance_cents: amt(r.balance_cents),
		balance_date: parseDate(r.balance_date ?? "") ?? null,
		confidence: Number.isFinite(Number(r.confidence)) && r.confidence !== null && r.confidence !== undefined ? Math.max(0, Math.min(1, Number(r.confidence))) : null,
		summary: str(r.summary, 300),
	};
	const useful = (info.amount_cents !== null && BigInt(info.amount_cents) > 0n) || info.due_date || info.balance_cents !== null;
	return useful ? info : null;
}

/**
 * A bill draft from what was kept about a statement (pure), or null when it doesn't say what is
 * owed (then the LLM reads the statement). An OFX ledger balance counts only for a card or loan
 * (liability) account, when it is owed: negative, or positive in a file whose signs are flipped.
 * account: the statement's account or null; last: the last transaction date.
 */
export function draftFromBillInfo(info, { account = null, flip = false, last = null } = {}) {
	if (!info || typeof info !== "object") return null;
	let amount = centsOrNull(info.amount_cents);
	if (amount !== null && amount <= 0n) amount = null;
	let billDate = info.statement_date ?? null;
	if (amount === null && info.balance_cents !== null && info.balance_cents !== undefined && account?.type === "liability") {
		const b = centsOrNull(info.balance_cents) ?? 0n;
		const owed = flip ? b : -b;
		if (owed > 0n) {
			amount = owed;
			billDate ??= info.balance_date ?? null;
		}
	}
	if (amount === null) return null;
	const minimum = centsOrNull(info.minimum_cents);
	return {
		kind: "bill",
		vendor: info.vendor || account?.name || "",
		invoice_number: info.reference ?? "",
		bill_date: billDate ?? last,
		due_date: info.due_date ?? null,
		amount_cents: amount,
		minimum_cents: minimum !== null && minimum > 0n ? minimum : null,
		currency: info.currency || account?.currency || "CAD",
		account_code: account && account.type === "liability" ? account.code : null,
		confidence: info.confidence ?? null,
		summary: info.summary ?? "",
		read_from: "saved",
		saved_from: info.from ?? "",
	};
}

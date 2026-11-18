// What was read out of a file, in the keys every Ledger module shares (ctx.documents.extracted /
// setExtracted, Ledger 0.27.0), so a file is read once: by this module's parsers, by the AI (once a
// person approved what it read), or by another module.
//
//   type, vendor, number, date, due_date, currency, total_cents, items: [{ description, quantity,
//   unit, rate_cents, amount_cents }], account: { number_last4 }, period: { from, to },
//   closing_balance_cents, transactions: [{ date, description, amount_cents, balance_cents? }]
//
// Money is integer cents; in transactions money out is negative. What only this module needs is
// under the key "categorizer": the parser's format, each line's memo and bank id (so a statement
// staged from the extraction is recognised as the same lines as one parsed from the file), whether
// the file's signs were flipped (a card export with purchases as positive amounts), and how a bill
// was read. These functions are pure: they turn the module's shapes into those keys and back.

import { parseDate } from "./parse.mjs";

export const MODULE_KEY = "categorizer";

const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && parseDate(s) === s;
/** Integer cents from what JSON carried (a number, or digits), as a bigint; null when it isn't one. */
export function cents(v) {
	if (typeof v === "bigint") return v;
	if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
	if (typeof v === "string" && /^-?\d{1,15}$/.test(v)) return BigInt(v);
	return null;
}
const num = (v) => (v === null || v === undefined ? null : Number(v));
const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const own = (data) => (data && typeof data[MODULE_KEY] === "object" && data[MODULE_KEY] !== null && !Array.isArray(data[MODULE_KEY]) ? data[MODULE_KEY] : {});

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

/**
 * A parsed statement (lib/parse.mjs, or the AI's reading) as extracted data. flipped: the person
 * said the file shows purchases as positive amounts; the transactions saved are then the other way
 * round, so that money out is negative for every module.
 * parsed: { format, transactions: [{ date, description, memo, amount_cents, fitid, balance_cents? }], balance?: { amount_cents, date } }.
 */
export function statementData(parsed, { flipped = false, currency = "", accountHint = "", type = "statement" } = {}) {
	const sign = flipped ? -1n : 1n;
	const txs = parsed.transactions;
	const transactions = txs.map((t) => {
		const out = { date: t.date, description: String(t.description ?? ""), amount_cents: Number(sign * BigInt(t.amount_cents)) };
		if (t.balance_cents !== undefined && t.balance_cents !== null) out.balance_cents = Number(sign * BigInt(t.balance_cents));
		return out;
	});
	const dates = txs.map((t) => t.date).filter(Boolean).sort();
	const mine = { format: parsed.format, flipped: flipped === true };
	if (txs.some((t) => t.memo)) mine.memos = txs.map((t) => String(t.memo ?? ""));
	if (txs.some((t) => t.fitid)) mine.bank_ids = txs.map((t) => String(t.fitid ?? ""));
	const data = { type, transactions, [MODULE_KEY]: mine };
	if (dates.length) data.period = { from: dates[0], to: dates.at(-1) };
	if (currency) data.currency = currency;
	if (/^\d{4}$/.test(accountHint)) data.account = { number_last4: accountHint };
	if (parsed.balance && parsed.balance.amount_cents !== undefined && parsed.balance.amount_cents !== null) {
		data.closing_balance_cents = Number(sign * BigInt(parsed.balance.amount_cents));
		if (parsed.balance.date) mine.balance_date = parsed.balance.date;
	}
	return data;
}

/**
 * Extracted data as a parsed statement, with the signs the file had (staging applies the
 * person's "flip signs" choice again), or null when it lists no usable transactions.
 * → { format, transactions: [{ line, date, description, memo, amount_cents, fitid }], warnings, balance?, flipped }
 */
export function parsedFromExtraction(data) {
	const list = Array.isArray(data?.transactions) ? data.transactions : [];
	if (list.length === 0 || list.length > 5000) return null;
	const mine = own(data);
	const sign = mine.flipped === true ? -1n : 1n;
	const memos = Array.isArray(mine.memos) ? mine.memos : [];
	const ids = Array.isArray(mine.bank_ids) ? mine.bank_ids : [];
	const transactions = [];
	let skipped = 0;
	for (const [i, t] of list.entries()) {
		const amount = cents(t?.amount_cents);
		if (!isDate(t?.date) || amount === null || amount === 0n) {
			skipped++;
			continue;
		}
		transactions.push({
			line: i + 1,
			date: t.date,
			description: text(t.description, 500) || "(no description)",
			memo: text(memos[i], 500),
			amount_cents: sign * amount,
			fitid: text(ids[i], 100),
		});
	}
	if (transactions.length === 0) return null;
	const out = {
		format: typeof mine.format === "string" && /^[a-z]{2,12}$/.test(mine.format) ? mine.format : "extracted",
		transactions,
		warnings: skipped ? [`${skipped} line${skipped === 1 ? "" : "s"} of what was read had no usable date or amount and ${skipped === 1 ? "was" : "were"} left out`] : [],
		flipped: mine.flipped === true,
	};
	const balance = cents(data.closing_balance_cents);
	if (balance !== null) out.balance = { amount_cents: sign * balance, date: isDate(mine.balance_date) ? mine.balance_date : isDate(data.period?.to) ? data.period.to : null };
	return out;
}

/** The transactions of extracted data with their signs turned round (the person changed "flip signs"): what to save. */
export function flippedData(data, flipped) {
	const mine = own(data);
	if ((mine.flipped === true) === (flipped === true) || !Array.isArray(data?.transactions)) return null;
	const turn = (v) => (cents(v) === null ? v : Number(-cents(v)));
	const out = {
		transactions: data.transactions.map((t) => (t && typeof t === "object" && !Array.isArray(t) ? { ...t, amount_cents: turn(t.amount_cents), ...(t.balance_cents !== undefined ? { balance_cents: turn(t.balance_cents) } : {}) } : t)),
		[MODULE_KEY]: { ...mine, flipped: flipped === true },
	};
	if (data.closing_balance_cents !== undefined) out.closing_balance_cents = turn(data.closing_balance_cents);
	return out;
}

/** "-42.10" → -4210n (exact), or null. */
export function decimalToCents(s) {
	const m = /^(-?)(\d{1,13})(?:\.(\d{1,2}))?$/.exec(String(s ?? "").trim());
	if (!m) return null;
	const v = BigInt(m[2]) * 100n + BigInt((m[3] ?? "").padEnd(2, "0") || "0");
	return m[1] ? -v : v;
}
/** -4210 → "-42.10" */
export function centsToDecimal(v) {
	const c = cents(v);
	if (c === null) return "";
	const abs = c < 0n ? -c : c;
	return `${c < 0n ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

/**
 * The rows a person approved in Extract data ([{ date, description, amount: "-42.10", balance: "" }])
 * as extracted data: a list of transactions any module can use.
 */
export function rowsData(rows, { currency = "", approvedBy = "" } = {}) {
	const transactions = [];
	for (const r of rows) {
		const amount = decimalToCents(r.amount);
		if (amount === null || !isDate(r.date)) continue;
		const t = { date: r.date, description: String(r.description ?? ""), amount_cents: Number(amount) };
		const balance = r.balance === "" || r.balance == null ? null : decimalToCents(r.balance);
		if (balance !== null) t.balance_cents = Number(balance);
		transactions.push(t);
	}
	const dates = transactions.map((t) => t.date).sort();
	const data = { type: "transactions", transactions, [MODULE_KEY]: { format: "extracted", flipped: false, read_by: "ai", ...(approvedBy ? { approved_by: approvedBy } : {}) } };
	if (dates.length) data.period = { from: dates[0], to: dates.at(-1) };
	if (/^[A-Z]{3}$/.test(currency)) data.currency = currency;
	const last = transactions.at(-1);
	if (last && last.balance_cents !== undefined) data.closing_balance_cents = last.balance_cents;
	return data;
}

/** Extracted transactions as Extract data's rows (for showing, and for a CSV). */
export function rowsFromData(data) {
	return (Array.isArray(data?.transactions) ? data.transactions : [])
		.filter((t) => isDate(t?.date) && cents(t?.amount_cents) !== null)
		.map((t) => ({ date: t.date, description: text(t.description, 500), amount: centsToDecimal(t.amount_cents), balance: t.balance_cents === undefined || t.balance_cents === null ? "" : centsToDecimal(t.balance_cents) }));
}

// ---------------------------------------------------------------------------
// What a statement says is owed (Create bill)
// ---------------------------------------------------------------------------

/**
 * What a statement says is owed (the module's bill_info: lib/bills.mjs billInfoOf) as extracted
 * data: vendor, date, due_date, total_cents (the amount owed), number, currency.
 */
export function billInfoData(info) {
	if (!info || typeof info !== "object") return null;
	const data = {};
	if (info.vendor) data.vendor = info.vendor;
	if (info.statement_date) data.date = info.statement_date;
	if (info.due_date) data.due_date = info.due_date;
	if (cents(info.amount_cents) !== null && cents(info.amount_cents) > 0n) data.total_cents = Number(cents(info.amount_cents));
	if (info.reference) data.number = info.reference;
	if (info.currency) data.currency = info.currency;
	const mine = {};
	if (cents(info.minimum_cents) !== null && cents(info.minimum_cents) > 0n) mine.minimum_cents = Number(cents(info.minimum_cents));
	if (info.confidence !== null && info.confidence !== undefined) mine.confidence = Number(info.confidence);
	if (info.summary) mine.summary = info.summary;
	if (info.from) mine.owed_from = info.from;
	return Object.keys(data).length ? { data, mine } : null;
}

/**
 * The module's bill_info from a statement's extracted data, or null when it says nothing about
 * what is owed. Its closing balance has the transactions' signs.
 */
export function billInfoFromData(data) {
	if (!data || typeof data !== "object") return null;
	const mine = own(data);
	const total = cents(data.total_cents);
	const balance = cents(data.closing_balance_cents);
	const info = {
		from: typeof mine.owed_from === "string" ? mine.owed_from : "extracted",
		vendor: text(data.vendor, 200),
		statement_date: isDate(data.date) ? data.date : null,
		due_date: isDate(data.due_date) ? data.due_date : null,
		amount_cents: total !== null && total > 0n ? total.toString() : null,
		minimum_cents: cents(mine.minimum_cents) !== null && cents(mine.minimum_cents) > 0n ? cents(mine.minimum_cents).toString() : null,
		reference: text(data.number, 100),
		currency: ["CAD", "USD"].includes(data.currency) ? data.currency : "",
		balance_cents: balance === null ? null : balance.toString(),
		balance_date: isDate(mine.balance_date) ? mine.balance_date : isDate(data.period?.to) ? data.period.to : null,
		confidence: Number.isFinite(Number(mine.confidence)) && mine.confidence !== null && mine.confidence !== undefined ? Math.max(0, Math.min(1, Number(mine.confidence))) : null,
		summary: text(mine.summary, 300),
	};
	return info.amount_cents !== null || info.due_date || info.balance_cents !== null ? info : null;
}

// ---------------------------------------------------------------------------
// Bills and receipts
// ---------------------------------------------------------------------------

/**
 * A bill or receipt a person approved (a bills row and its line items) as extracted data. Fields
 * the bill doesn't have are null, which takes an older value off the document.
 */
export function billData(bill, items = []) {
	const amount = cents(bill.amount_cents);
	return {
		type: bill.kind === "receipt" ? "receipt" : "bill",
		vendor: bill.vendor || null,
		number: bill.invoice_number || null,
		date: bill.bill_date || null,
		due_date: bill.due_date || null,
		currency: bill.currency || null,
		total_cents: amount === null ? null : Number(amount),
		entity_id: bill.vendor_entity_id === null || bill.vendor_entity_id === undefined ? null : Number(bill.vendor_entity_id),
		items: items.length
			? items.map((it) => ({
					description: it.description,
					quantity: it.quantity === null || it.quantity === undefined || it.quantity === "" ? null : Number(it.quantity),
					unit: it.unit || null,
					rate_cents: num(it.rate_cents),
					amount_cents: num(it.amount_cents),
				}))
			: null,
		[MODULE_KEY]: { read_by: bill.confidence === null || bill.confidence === undefined ? "person" : "ai", ...(bill.summary ? { summary: bill.summary } : {}) },
	};
}

/**
 * Extracted data as what reading a bill gives (lib/bills.mjs extractBill), or null when it isn't a
 * bill or receipt with at least a vendor or a total. Then the AI isn't asked again.
 */
export function billFromData(data) {
	if (!data || typeof data !== "object") return null;
	const type = typeof data.type === "string" ? data.type.toLowerCase() : "";
	const isBill = type === "bill" || type === "receipt" || (type === "invoice" && !!data.vendor && !data.customer);
	if (!isBill) return null;
	const total = cents(data.total_cents);
	const vendor = text(data.vendor, 200);
	if (!vendor && (total === null || total <= 0n)) return null;
	const mine = own(data);
	const items = [];
	for (const it of Array.isArray(data.items) ? data.items.slice(0, 100) : []) {
		const description = text(it?.description, 100);
		if (!description) continue;
		const q = Number(it.quantity);
		const quantity = it.quantity !== null && it.quantity !== undefined && Number.isFinite(q) && q > 0 && q < 1e12 ? String(Math.round(q * 10000) / 10000) : null;
		const rate = cents(it.rate_cents);
		const amount = cents(it.amount_cents);
		if (quantity === null && (rate === null || rate < 0n) && amount === null) continue;
		const unit = text(it.unit, 20).toLowerCase();
		items.push({
			description,
			quantity: quantity ?? (rate === null || rate < 0n ? "1" : null),
			unit: /^[a-z][a-z0-9 ./_-]{0,19}$/.test(unit) ? unit : "",
			rate_cents: rate !== null && rate >= 0n ? rate : quantity === null && amount !== null && amount >= 0n ? amount : null,
			amount_cents: amount,
		});
	}
	return {
		kind: type === "receipt" ? "receipt" : "bill",
		vendor,
		invoice_number: text(data.number, 100),
		bill_date: isDate(data.date) ? data.date : null,
		due_date: isDate(data.due_date) ? data.due_date : null,
		amount_cents: total !== null && total > 0n ? total : null,
		currency: ["CAD", "USD"].includes(data.currency) ? data.currency : data.currency ? "other" : "",
		account_code: null,
		confidence: null,
		summary: text(mine.summary, 300),
		items,
	};
}

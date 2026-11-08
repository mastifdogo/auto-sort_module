// Finding the same transaction elsewhere: journal entries already in the books, lines on other
// statements, bills and receipts. Candidates are narrowed by amount and date here; the LLM (Auto
// sort button) picks among them, and a person approves what it picks.

import { matchScore } from "./bills.mjs";

export const WINDOW_DAYS = 10;
const DAY = 86_400_000;
const days = (iso) => Date.parse(iso + "T00:00:00Z") / DAY;
export const shiftDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);

/**
 * Journal entries a bill or receipt may already be recorded in (no AI): an entry, not linked by
 * this module and not reversed, with a line of exactly the bill's amount in the bill's date window
 * (scored like a payment: vendor words in the description raise it). bills: [{ id, kind, vendor,
 * amount_cents, bill_date, due_date }]; entries: Ledger's JournalEntry objects. Returns
 * [{ bill, entry, score }], one per bill and per entry, best first.
 */
export function findBillEntryMatches(bills, entries, moduleId) {
	const usable = entries.filter((e) => e.reverses_id == null && e.reversed_by_id == null && !(e.links ?? []).some((l) => l.module_id === moduleId));
	const pairs = [];
	for (const b of bills) {
		if (b.amount_cents == null) continue;
		const amount = BigInt(b.amount_cents);
		for (const e of usable) {
			if (!e.lines.some((l) => BigInt(l.debit_cents) === amount || BigInt(l.credit_cents) === amount)) continue;
			const score = matchScore(b, { amount_cents: -amount, date: e.entry_date, description: `${e.description} ${e.reference ?? ""}` });
			if (score > 0) pairs.push({ bill: b, entry: e, score });
		}
	}
	pairs.sort((x, y) => y.score - x.score);
	const usedB = new Set();
	const usedE = new Set();
	const out = [];
	for (const p of pairs) {
		if (usedB.has(String(p.bill.id)) || usedE.has(String(p.entry.id))) continue;
		usedB.add(String(p.bill.id));
		usedE.add(String(p.entry.id));
		out.push(p);
	}
	return out;
}

/**
 * Candidates for one statement row: journal entries with a line on the row's account for its exact
 * signed amount (already recorded), unposted rows on other statements with the same amount (a
 * duplicate) or the opposite amount on another account (the other side of a transfer), and open
 * bills or receipts it could pay. All within WINDOW_DAYS. At most `limit`, closest dates first.
 * Ids are "e<entry>", "t<row>", "b<bill>".
 */
export function rowCandidates(row, { entries = [], rows = [], bills = [] }, moduleId, limit = 8) {
	const amt = BigInt(row.amount_cents);
	const near = (date) => Math.abs(days(date) - days(row.date)) <= WINDOW_DAYS;
	const out = [];
	for (const e of entries) {
		if (e.reverses_id != null || e.reversed_by_id != null || (e.links ?? []).some((l) => l.module_id === moduleId) || !near(e.entry_date)) continue;
		const line = e.lines.find((l) => l.account_code === row.account_code && BigInt(l.debit_cents) - BigInt(l.credit_cents) === amt);
		if (!line) continue;
		out.push({ id: `e${e.id}`, kind: "entry", target_id: e.id, date: e.entry_date, description: e.description, amount_cents: amt, detail: `journal entry #${e.id}, accounts ${[...new Set(e.lines.map((l) => l.account_code))].join(", ")}` });
	}
	for (const r of rows) {
		if (String(r.id) === String(row.id) || String(r.statement_id) === String(row.statement_id) || !near(r.date)) continue;
		const same = r.account_code === row.account_code && BigInt(r.amount_cents) === amt;
		const transfer = r.account_code !== row.account_code && BigInt(r.amount_cents) === -amt;
		if (!same && !transfer) continue;
		out.push({ id: `t${r.id}`, kind: "transaction", target_id: r.id, date: r.date, description: r.description, amount_cents: BigInt(r.amount_cents), detail: `${same ? "line on another statement for the same account" : `line on account ${r.account_code} (a transfer?)`}${r.status === "posted" ? ", already posted" : ""}` });
	}
	if (amt < 0n) {
		for (const b of bills) {
			if (b.amount_cents == null || BigInt(b.amount_cents) !== -amt) continue;
			const anchor = b.due_date ?? b.bill_date;
			if (anchor && Math.abs(days(anchor) - days(row.date)) > 60) continue;
			out.push({ id: `b${b.id}`, kind: "bill", target_id: b.id, date: anchor ?? "", description: `${b.vendor}${b.invoice_number ? ` ${b.invoice_number}` : ""}`, amount_cents: -BigInt(b.amount_cents), detail: `${b.kind}, ${b.status === "new" ? "not approved yet" : "approved"}` });
		}
	}
	const dist = (c) => (c.date ? Math.abs(days(c.date) - days(row.date)) : 99);
	return out.sort((a, b) => dist(a) - dist(b)).slice(0, limit);
}

/** Candidates for a bill or receipt: unposted rows that could pay it, and entries already recording it. */
export function billCandidates(bill, { entries = [], rows = [] }, moduleId, limit = 10) {
	if (bill.amount_cents == null) return [];
	const amount = BigInt(bill.amount_cents);
	const lo = days(bill.bill_date ?? bill.due_date ?? bill.created ?? "2000-01-01") - (bill.kind === "receipt" ? 5 : 10);
	const hi = days(bill.due_date ?? bill.bill_date ?? "2100-01-01") + (bill.kind === "receipt" ? 15 : 60);
	const inWindow = (date) => days(date) >= lo && days(date) <= hi;
	const out = [];
	for (const r of rows) {
		if (BigInt(r.amount_cents) !== -amount || !inWindow(r.date)) continue;
		out.push({ id: `t${r.id}`, kind: "transaction", target_id: r.id, date: r.date, description: r.description, amount_cents: BigInt(r.amount_cents), detail: `unposted line on account ${r.account_code}` });
	}
	for (const e of entries) {
		if (e.reverses_id != null || e.reversed_by_id != null || (e.links ?? []).some((l) => l.module_id === moduleId) || !inWindow(e.entry_date)) continue;
		if (!e.lines.some((l) => BigInt(l.debit_cents) === amount || BigInt(l.credit_cents) === amount)) continue;
		out.push({ id: `e${e.id}`, kind: "entry", target_id: e.id, date: e.entry_date, description: e.description, amount_cents: -amount, detail: `journal entry #${e.id}, accounts ${[...new Set(e.lines.map((l) => l.account_code))].join(", ")}` });
	}
	const mid = (lo + hi) / 2;
	return out.sort((a, b) => Math.abs(days(a.date) - mid) - Math.abs(days(b.date) - mid)).slice(0, limit);
}

export const MATCH_SYSTEM = `You help a bookkeeper avoid recording the same money twice. For each item (a bank or card statement line, or a bill or receipt), decide which candidate, if any, is the very same real-world transaction:
- a journal entry already in the books (then the item is already recorded),
- a line on another statement (the same payment uploaded twice, or the other side of a transfer between the user's own accounts),
- a bill or receipt that the line pays.
Candidates already have the right amount and a close date; judge by payee or vendor names, references, dates and what the descriptions say. Answer match "" when none is clearly the same transaction; a similar amount alone is not enough. confidence is your probability that the match is right. reason: at most 15 words.`;

/** The prompt and schema for a batch of items: [{ i, item: { date, description, amount_cents, extra }, candidates }]. */
export function matchRequest(items, formatCents) {
	const ids = [...new Set(items.flatMap((it) => it.candidates.map((c) => c.id)))];
	const lines = [];
	for (const it of items) {
		lines.push(`Item ${it.i}: ${JSON.stringify({ date: it.item.date, description: it.item.description, amount: formatCents(BigInt(it.item.amount_cents)), ...(it.item.extra ? { about: it.item.extra } : {}) })}`);
		for (const c of it.candidates) lines.push(`  candidate ${c.id}: ${JSON.stringify({ date: c.date, description: c.description, amount: formatCents(c.amount_cents), what: c.detail })}`);
	}
	return {
		system: MATCH_SYSTEM,
		prompt: [`Decide for each of these ${items.length} items. Return one result per item, using its number as i.`, "", ...lines].join("\n"),
		schema: {
			type: "object",
			properties: {
				results: {
					type: "array",
					items: {
						type: "object",
						properties: {
							i: { type: "integer" },
							match: { type: "string", enum: [...ids, ""] },
							confidence: { type: "number", description: "0 to 1" },
							reason: { type: "string" },
						},
						required: ["i", "match", "confidence", "reason"],
						additionalProperties: false,
					},
				},
			},
			required: ["results"],
			additionalProperties: false,
		},
	};
}

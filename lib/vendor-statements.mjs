// A vendor's statement of account: the supplier's own list of their invoices, our payments and
// credit notes, with the balance they say is owed. It is not a bill (nothing new is owed because of
// it) and nothing is posted for it: it is reconciled against the vendor's own account on Ledger's
// Reconcile page (ctx.reconcile, Ledger 0.34.0), where a person sees which of its lines the books
// don't have.
//
// Pure helpers: what the AI (or a person) gives for a statement, cleaned up; what is handed to
// ctx.reconcile.start; and what Ledger says about a statement's reconciliation.
//
// Signs, everywhere here and in Ledger: the vendor account's own sign. An invoice or a charge is
// positive (it makes what is owed go up), a payment or a credit note negative, and a balance is
// what is owed (negative: the vendor owes us).

import { parseAmount, parseDate } from "./parse.mjs";

/** Ledger takes at most this many statement lines (statement-reading.ts). */
export const MAX_LINES = 2000;
export const MAX_DESCRIPTION = 300;
const MAX_CENTS = 10n ** 13n;

/** The JSON schema of a statement's lines in the reading of a document (lib/bills.mjs). */
export const STATEMENT_LINE_SCHEMA = {
	type: "object",
	properties: {
		date: { type: "string", description: "YYYY-MM-DD" },
		description: { type: "string", description: "what the line is, with its reference: the invoice, credit note or payment number as printed" },
		amount: { type: "string", description: 'signed decimal, e.g. "450.00" for an invoice or a charge, "-200.00" for a payment or a credit note' },
	},
	required: ["date", "description", "amount"],
	additionalProperties: false,
};

/** A signed amount as cents (bigint), or null: a decimal string, a number, or whole cents under amount_cents. */
function centsOf(raw) {
	if (raw === null || raw === undefined || raw === "") return null;
	const c = parseAmount(typeof raw === "number" ? (Number.isFinite(raw) ? raw.toFixed(2) : "") : String(raw));
	return c === null || c > MAX_CENTS || c < -MAX_CENTS ? null : c;
}

/** Whole cents given as such (a number, a bigint or a string of digits), or null. */
function wholeCents(raw) {
	if (typeof raw === "bigint") return raw > MAX_CENTS || raw < -MAX_CENTS ? null : raw;
	if (typeof raw === "number") return Number.isSafeInteger(raw) ? wholeCents(BigInt(raw)) : null;
	return typeof raw === "string" && /^-?\d{1,15}$/.test(raw) ? wholeCents(BigInt(raw)) : null;
}

/**
 * One statement line, cleaned up: { date, description, amount_cents (bigint, never 0) }, or null
 * when it has no date or no amount (a subtotal, a heading, a "balance forward" row without one).
 * Takes `amount` (a decimal, as read or typed) or `amount_cents`.
 */
export function normalizeLine(raw) {
	if (!raw || typeof raw !== "object") return null;
	const date = parseDate(raw.date ?? raw.line_date ?? "") ?? null;
	const amount = raw.amount_cents !== undefined && raw.amount_cents !== null ? wholeCents(raw.amount_cents) : centsOf(raw.amount);
	if (!date || amount === null || amount === 0n) return null;
	return { date, description: String(raw.description ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_DESCRIPTION), amount_cents: amount };
}

/** A list of lines cleaned up, in the order given; the ones that aren't lines are left out. */
export function normalizeLines(list) {
	const out = [];
	for (const raw of Array.isArray(list) ? list : []) {
		const l = normalizeLine(raw);
		if (l) out.push(l);
		if (out.length >= MAX_LINES) break;
	}
	return out;
}

/**
 * What the reading of a document says about a statement of account → { period_start,
 * opening_balance_cents, closing_balance_cents, lines }. data: the LLM's answer (lib/bills.mjs:
 * period_start, opening_balance, closing_balance, statement_lines). Nothing is guessed: a balance
 * that wasn't read is null.
 */
export function statementFromReading(data) {
	return {
		period_start: parseDate(data?.period_start ?? "") ?? null,
		opening_balance_cents: centsOf(data?.opening_balance),
		closing_balance_cents: centsOf(data?.closing_balance),
		lines: normalizeLines(data?.statement_lines),
	};
}

/** Whether the opening balance plus the lines gives the closing balance (null: one of them isn't known). */
export function addsUp(statement, lines) {
	if (statement?.opening_balance_cents == null || statement?.closing_balance_cents == null) return null;
	const sum = lines.reduce((s, l) => s + BigInt(l.amount_cents), 0n);
	return BigInt(statement.opening_balance_cents) + sum === BigInt(statement.closing_balance_cents);
}

/**
 * What ctx.reconcile.start is given for a vendor statement, or { error } saying what a person has
 * to fill in first. accountCode: the vendor's own account; documentId: the statement's document in
 * Ledger's Documents (null: none); statement: { statement_date, closing_balance_cents,
 * opening_balance_cents, period_start }; lines: the module's own reading, passed so Ledger doesn't
 * ask the AI again. Amounts go as they are kept: the vendor account's own sign.
 */
export function reconcileInput({ accountCode, documentId = null, statement, lines }) {
	if (!statement?.statement_date) return { error: "enter the statement's date first" };
	if (statement.closing_balance_cents == null) return { error: "enter the balance the statement says is owed first (0 when nothing is)" };
	const input = {
		account_code: accountCode,
		statement_date: statement.statement_date,
		statement_balance_cents: Number(statement.closing_balance_cents),
		lines: lines.map((l) => ({ date: l.date, description: l.description, amount_cents: Number(l.amount_cents) })),
	};
	if (documentId != null) input.document_id = Number(documentId);
	if (statement.opening_balance_cents != null) input.opening_balance_cents = Number(statement.opening_balance_cents);
	if (statement.period_start) input.period_start = statement.period_start;
	return { input };
}

/**
 * The state of a statement's reconciliation as Ledger tells it. id: the reconciliation the module
 * started for it (null: none); list: ctx.reconcile.list(account) rows; open: ctx.reconcile.open(account)
 * (the detail of the one in progress, or null). → { state: "none" | "open" | "finished", … }.
 * A reconciliation deleted in Ledger since is "none" again. other_open: the vendor's account has
 * another reconciliation in progress (one started in Ledger, or for another statement).
 */
export function reconciliationState(id, list = [], open = null) {
	const href = (x) => `/reconcile/${x}`;
	// Ledger hands times over as Dates (or text, through JSON).
	const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
	const openRow = open?.reconciliation ?? (list ?? []).find((r) => r.status === "open") ?? null;
	const other = openRow && (id == null || String(openRow.id) !== String(id)) ? { id: Number(openRow.id), href: href(openRow.id), statement_date: iso(openRow.statement_date)?.slice(0, 10) ?? null } : null;
	const mine = id == null ? null : ((list ?? []).find((r) => String(r.id) === String(id)) ?? (open && String(open.reconciliation?.id) === String(id) ? open.reconciliation : null));
	if (!mine) return { state: "none", other_open: other };
	const base = { id: Number(mine.id), href: href(mine.id), statement_date: iso(mine.statement_date)?.slice(0, 10) ?? null, statement_balance_cents: mine.statement_balance_cents ?? null, other_open: other };
	if (mine.status === "finished") return { ...base, state: "finished", finished_at: iso(mine.finished_at), finished_by: mine.finished_by ?? null };
	const out = { ...base, state: "open", started_by: mine.created_by ?? null };
	// The one in progress: what Ledger found so far (read each time, never kept here).
	if (open && String(open.reconciliation?.id) === String(id)) {
		const reading = open.reading ?? null;
		out.difference_cents = open.difference_cents ?? null;
		out.matched = reading ? reading.matched.length : null;
		// Statement lines the books don't have: the missing bills and payments to go and find.
		out.unmatched = reading ? reading.unmatched.map((i) => reading.lines[i]).filter(Boolean).map((l) => ({ date: l.date, description: l.description, amount_cents: l.amount_cents })) : null;
		// Lines in the vendor's account the statement doesn't list.
		out.not_on_statement = Array.isArray(open.lines) ? open.lines.filter((l) => !l.cleared).length : null;
	}
	return out;
}

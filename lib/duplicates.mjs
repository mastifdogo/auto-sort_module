// Duplicate transactions: the same payment staged twice (e.g. a CSV and an OFX export of the same
// period, or a pending and a posted copy a day apart), or a staged row already entered in the
// journal by hand. Rows on the same statement are never paired: a bank lists real repeats.

import { nameTokens } from "./bills.mjs";

export const MAX_DAYS = 3;
const DAY = 86_400_000;
const days = (iso) => Date.parse(iso + "T00:00:00Z") / DAY;

/** Share of the shorter description's distinctive words found in the other (0 to 1). */
export function similarity(a, b) {
	const ta = nameTokens(a);
	const tb = nameTokens(b);
	if (ta.size === 0 || tb.size === 0) return 0;
	let n = 0;
	for (const t of ta) if (tb.has(t)) n++;
	return n / Math.min(ta.size, tb.size);
}

/** How likely two rows on the same account are one transaction: 0 (no) to 0.99. Needs the exact amount within a few days. */
export function duplicateScore(a, b) {
	if (BigInt(a.amount_cents) !== BigInt(b.amount_cents)) return 0;
	const gap = Math.abs(days(a.date) - days(b.date));
	if (gap > MAX_DAYS) return 0;
	const s = 0.4 + (gap === 0 ? 0.3 : gap <= 1 ? 0.15 : 0) + 0.3 * similarity(a.description, b.description);
	return s >= 0.6 ? Math.min(0.99, Math.round(s * 100) / 100) : 0;
}

/** Which of two duplicates to keep: a posted one, then one with more done to it, then the older. */
function keeper(a, b) {
	const rank = (t) => (t.status === "posted" ? 4 : 0) + (t.chosen_code ? 2 : 0) + (t.bill_id || t.transfer_tx_id || t.transfer_entry_id ? 1 : 0);
	const ra = rank(a);
	const rb = rank(b);
	if (ra !== rb) return ra > rb ? [a, b] : [b, a];
	return BigInt(a.id) < BigInt(b.id) ? [a, b] : [b, a];
}

const pairKey = (a, b) => (BigInt(a) < BigInt(b) ? `${a}-${b}` : `${b}-${a}`);
export { pairKey };

/**
 * Pairs of staged rows that look like one transaction. rows: [{ id, statement_id, account_code, date,
 * description, amount_cents, status, chosen_code, bill_id, transfer_tx_id, transfer_entry_id }] (new or
 * posted); dismissed: Set of pairKey()s. Each row is in at most one pair, best first; the row to merge
 * away is always unposted. Returns [{ keep, merge, score }].
 */
export function findDuplicatePairs(rows, dismissed = new Set(), { includePosted = false } = {}) {
	const groups = Map.groupBy(
		rows.filter((r) => r.account_code),
		(r) => `${r.account_code}|${BigInt(r.amount_cents)}`,
	);
	const pairs = [];
	for (const list of groups.values()) {
		for (let i = 0; i < list.length; i++) {
			for (let j = i + 1; j < list.length; j++) {
				const a = list[i];
				const b = list[j];
				if (String(a.statement_id) === String(b.statement_id)) continue;
				// Two posted rows are only looked at in a recheck (one entry then gets reversed); never the same entry.
				if (a.status !== "new" && b.status !== "new" && (!includePosted || (a.journal_entry_id != null && String(a.journal_entry_id) === String(b.journal_entry_id)))) continue;
				if (String(a.transfer_tx_id) === String(b.id) || String(b.transfer_tx_id) === String(a.id)) continue;
				if (dismissed.has(pairKey(a.id, b.id))) continue;
				const score = duplicateScore(a, b);
				if (score === 0) continue;
				const [keep, merge] = keeper(a, b);
				if (merge.status !== "new" && !(includePosted && keep.status === "posted")) continue;
				pairs.push({ keep, merge, score, both_posted: merge.status === "posted" });
			}
		}
	}
	pairs.sort((x, y) => y.score - x.score);
	const used = new Set();
	const out = [];
	for (const p of pairs) {
		const k = String(p.keep.id);
		const m = String(p.merge.id);
		if (used.has(k) || used.has(m)) continue;
		used.add(k).add(m);
		out.push(p);
	}
	return out;
}

/**
 * Unposted rows already in the journal: an entry on the row's account, not posted by this module,
 * with the same signed amount within a few days. rows: unposted rows of one account; lines: that
 * account's ledger lines ({ journal_entry_id, entry_date, description, debit_cents, credit_cents });
 * claimed: Set of entry ids this module posted or linked; dismissed: Set of "tx-entry" keys.
 * Returns [{ merge, entry: { id, date, description, amount_cents }, score }], one per row and per entry.
 */
export function findEntryDuplicates(rows, lines, claimed = new Set(), dismissed = new Set()) {
	const entries = lines
		.filter((l) => !claimed.has(String(l.journal_entry_id)))
		.map((l) => ({ id: l.journal_entry_id, date: l.entry_date, description: l.description, amount_cents: BigInt(l.debit_cents) - BigInt(l.credit_cents) }));
	const pairs = [];
	for (const r of rows) {
		if (r.status !== "new" || r.transfer_entry_id || r.transfer_tx_id) continue;
		for (const e of entries) {
			if (dismissed.has(`${r.id}-${e.id}`)) continue;
			const score = duplicateScore(r, e);
			if (score > 0) pairs.push({ merge: r, entry: e, score });
		}
	}
	pairs.sort((x, y) => y.score - x.score);
	const usedRows = new Set();
	const usedEntries = new Set();
	const out = [];
	for (const p of pairs) {
		if (usedRows.has(String(p.merge.id)) || usedEntries.has(String(p.entry.id))) continue;
		usedRows.add(String(p.merge.id));
		usedEntries.add(String(p.entry.id));
		out.push(p);
	}
	return out;
}

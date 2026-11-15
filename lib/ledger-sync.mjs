// Keeping up with changes people make in Ledger itself (Ledger 0.19.3–0.19.5).

/**
 * Ledger rewrites a renumbered account's code in columns named account_code,
 * *_account_code and *_account. These columns keep codes under other names
 * (from before that rule), so they follow here.
 */
export async function renameAccountCode(q, T, { old_code, new_code }) {
	if (typeof old_code !== "string" || typeof new_code !== "string" || !old_code || old_code === new_code) return;
	await q(`UPDATE ${T("transactions")} SET suggested_code = $2 WHERE suggested_code = $1`, [old_code, new_code]);
	await q(`UPDATE ${T("transactions")} SET chosen_code = $2 WHERE chosen_code = $1`, [old_code, new_code]);
	await q(`UPDATE ${T("statements")} SET account_guess = $2 WHERE account_guess = $1`, [old_code, new_code]);
	// A proposed new account (not created yet) can name the old code as its parent, or as its own code.
	await q(`UPDATE ${T("transactions")} SET new_account = jsonb_set(new_account, '{parent_code}', to_jsonb($2::text)) WHERE new_account->>'parent_code' = $1`, [old_code, new_code]);
	await q(`UPDATE ${T("transactions")} SET new_account = jsonb_set(new_account, '{code}', to_jsonb($2::text)) WHERE new_account->>'code' = $1`, [old_code, new_code]);
}

/** An entry's net amount (debits − credits) on one account, in cents. */
export function netOn(entry, code) {
	let n = 0n;
	for (const l of entry?.lines ?? []) {
		if (l.account_code !== code) continue;
		n += BigInt(String(l.debit_cents ?? 0)) - BigInt(String(l.credit_cents ?? 0));
	}
	return n;
}

/** Reads entries by id, a few at a time; ones that can't be read are left out. */
export async function readEntries(ctx, ids) {
	const out = new Map();
	const todo = [...new Set(ids.filter((x) => x !== null && x !== undefined).map(String))];
	const worker = async () => {
		while (todo.length) {
			const id = todo.shift();
			try {
				const e = await ctx.ledger.getJournalEntry(id);
				if (e) out.set(id, e);
			} catch {
				/* gone or unreadable: nothing to compare */
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(6, todo.length) }, worker));
	return out;
}

/**
 * A person can change a posted entry's amounts in Ledger (0.19.5). Marks each
 * posted row whose entry now books a different amount on `code` than the row
 * says: entry_amended and entry_amount_cents (the entry's amount, same sign
 * as the row). Neither is overwritten; the page shows both.
 */
export async function markAmended(ctx, rows, code, { idKey = "journal_entry_id", amountOf = (r) => r.amount_cents, sign = 1n } = {}) {
	const posted = rows.filter((r) => r[idKey] !== null && r[idKey] !== undefined);
	if (!posted.length || typeof ctx.ledger.getJournalEntry !== "function") return rows;
	const entries = await readEntries(ctx, posted.map((r) => r[idKey]));
	for (const r of posted) {
		const e = entries.get(String(r[idKey]));
		if (!e?.amended) continue;
		const now = netOn(e, typeof code === "function" ? code(r) : code) * sign;
		const was = BigInt(String(amountOf(r) ?? 0));
		if (now !== was) {
			r.entry_amended = true;
			r.entry_amount_cents = now;
		}
	}
	return rows;
}

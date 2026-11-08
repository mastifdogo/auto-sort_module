// The Duplicates tab: likely duplicate transactions (lib/duplicates.mjs), merged into the one kept
// or marked as not duplicates. A merged row is never posted; Unmerge brings it back.

import { findDuplicatePairs, findEntryDuplicates, pairKey } from "./duplicates.mjs";
import { dashboard } from "./dashboard.mjs";

export function registerDuplicates(ctx, { q, T, bad, bills, transfers, syncStatementNotice, requeue: requeueStatements, txLink, linkEntry }) {
	const dash = dashboard(ctx);

	const view = (t) => ({
		id: t.id,
		statement_id: t.statement_id,
		filename: t.filename,
		account_code: t.account_code,
		date: t.date,
		description: t.description,
		memo: t.memo,
		amount_cents: t.amount_cents,
		status: t.status,
		category: t.category,
	});

	/** Every likely duplicate among staged rows, and staged rows already in the journal. */
	async function scan() {
		const { rows } = await q(
			`WITH w AS (SELECT account_code, min(tx_date) - 3 AS lo, max(tx_date) + 3 AS hi FROM ${T("transactions")}
			             WHERE status = 'new' AND account_code <> '' GROUP BY account_code)
			 SELECT t.id, t.statement_id, s.filename, t.account_code, t.tx_date::text AS date, t.description, t.memo, t.amount_cents, t.status,
			        t.chosen_code, COALESCE(t.chosen_code, t.suggested_code) AS category, t.bill_id, t.transfer_tx_id, t.transfer_entry_id,
			        w.lo::text AS lo, w.hi::text AS hi
			   FROM ${T("transactions")} t JOIN w ON w.account_code = t.account_code AND t.tx_date BETWEEN w.lo AND w.hi
			   JOIN ${T("statements")} s ON s.id = t.statement_id
			  WHERE t.status IN ('new', 'posted')`,
		);
		if (rows.length === 0) return { pairs: [], entries: [] };
		const { rows: dis } = await q(`SELECT tx_id, other_id, entry_id FROM ${T("not_duplicates")}`);
		const dismissedPairs = new Set(dis.filter((d) => d.other_id !== null).map((d) => pairKey(d.tx_id, d.other_id)));
		const dismissedEntries = new Set(dis.filter((d) => d.entry_id !== null).map((d) => `${d.tx_id}-${d.entry_id}`));
		const pairs = findDuplicatePairs(rows, dismissedPairs);
		const inPair = new Set(pairs.flatMap((p) => [String(p.keep.id), String(p.merge.id)]));

		const entries = [];
		for (const [code, list] of Map.groupBy(rows, (r) => r.account_code)) {
			const open = list.filter((r) => r.status === "new" && !inPair.has(String(r.id)));
			if (open.length === 0) continue;
			let ledger;
			try {
				ledger = await ctx.ledger.accountLedger(code, { from: list[0].lo, to: list[0].hi });
			} catch {
				continue;
			}
			const { rows: claimedRows } = await q(
				`SELECT journal_entry_id AS id FROM ${T("transactions")} WHERE account_code = $1 AND journal_entry_id IS NOT NULL
				 UNION SELECT transfer_entry_id FROM ${T("transactions")} WHERE account_code = $1 AND transfer_entry_id IS NOT NULL
				 UNION SELECT duplicate_entry_id FROM ${T("transactions")} WHERE account_code = $1 AND duplicate_entry_id IS NOT NULL`,
				[code],
			);
			const claimed = new Set(claimedRows.map((r) => String(r.id)));
			for (const p of findEntryDuplicates(open, ledger.lines, claimed, dismissedEntries)) {
				// A reversed entry (or the reversal itself) isn't really in the books.
				const e = await ctx.ledger.getJournalEntry(p.entry.id).catch(() => null);
				if (!e || e.reverses_id != null || e.reversed_by_id != null) continue;
				entries.push({ ...p, entry: { ...p.entry, reference: e.reference ?? "", lines: e.lines.map((l) => l.account_code) } });
			}
		}
		return { pairs, entries };
	}

	async function syncTodo(n) {
		if (n > 0) {
			await dash.todo({
				key: "duplicates",
				title: `${n} possible duplicate transaction${n === 1 ? "" : "s"}`,
				body: `Merge them or mark them as not duplicates on ${ctx.name}'s Duplicates tab before posting.`,
				level: "warning",
				link: `${dash.link}?tab=duplicates`,
			});
		} else await dash.complete("duplicates");
	}

	/** Looks again and updates the dashboard to-do (after statements are categorised). */
	async function refresh() {
		const { pairs, entries } = await scan();
		await syncTodo(pairs.length + entries.length);
		return pairs.length + entries.length;
	}

	ctx.route("GET", "/duplicates", async () => {
		const { pairs, entries } = await scan();
		await syncTodo(pairs.length + entries.length);
		return {
			pairs: pairs.map((p) => ({ score: p.score, keep: view(p.keep), merge: view(p.merge) })),
			entries: entries.map((p) => ({ score: p.score, merge: view(p.merge), entry: p.entry })),
			count: pairs.length + entries.length,
		};
	});

	async function row(id, what) {
		if (typeof id !== "number" && !(typeof id === "string" && /^\d+$/.test(id))) throw bad(`${what} must be a transaction id`);
		const { rows } = await q(
			`SELECT t.id, t.statement_id, t.account_code, t.amount_cents, t.status, t.chosen_code, t.bill_id, t.transfer_tx_id, t.duplicate_entry_id, t.description, s.filename
			   FROM ${T("transactions")} t JOIN ${T("statements")} s ON s.id = t.statement_id WHERE t.id = $1`,
			[String(id)],
		);
		if (rows.length === 0) throw new ctx.HttpError(404, `no transaction ${id}`);
		return rows[0];
	}

	// POST /duplicates/merge {merge_id, keep_id} or {merge_id, entry_id}: merge_id is never posted.
	ctx.route("POST", "/duplicates/merge", async (req) => {
		const b = req.body ?? {};
		const merge = await row(b.merge_id, "merge_id");
		if (merge.status !== "new") throw new ctx.HttpError(409, `transaction ${merge.id} is ${merge.status}; only unposted rows can be merged`);
		let keep = null;
		let entryId = null;
		if (b.keep_id !== undefined) {
			keep = await row(b.keep_id, "keep_id");
			if (String(keep.id) === String(merge.id)) throw bad("keep_id and merge_id must differ");
			if (!["new", "posted"].includes(keep.status)) throw new ctx.HttpError(409, `transaction ${keep.id} is ${keep.status}`);
			if (keep.account_code !== merge.account_code || BigInt(keep.amount_cents) !== BigInt(merge.amount_cents)) {
				throw bad("only rows on the same account with the same amount can be merged");
			}
		} else if (b.entry_id !== undefined) {
			if (!Number.isSafeInteger(Number(b.entry_id)) || Number(b.entry_id) <= 0) throw bad("entry_id must be a journal entry id");
			const e = await ctx.ledger.getJournalEntry(Number(b.entry_id)).catch(() => null);
			if (!e) throw new ctx.HttpError(404, `no journal entry ${b.entry_id}`);
			if (!e.lines.some((l) => l.account_code === merge.account_code)) throw bad(`entry ${e.id} doesn't touch account ${merge.account_code}`);
			entryId = e.id;
		} else throw bad("keep_id or entry_id is required");

		// The kept row inherits the account you chose for the merged one.
		if (keep && keep.status === "new" && !keep.chosen_code && merge.chosen_code) {
			await q(`UPDATE ${T("transactions")} SET chosen_code = $2 WHERE id = $1 AND status = 'new'`, [keep.id, merge.chosen_code]);
		}
		// Its other side of a transfer goes back to being an ordinary row.
		const requeue = new Set();
		if (merge.transfer_tx_id) {
			const { rows } = await q(
				`UPDATE ${T("transactions")} SET transfer_tx_id = NULL, suggested_code = NULL, source = '', reason = '' WHERE id = $1 AND status = 'new' RETURNING statement_id`,
				[merge.transfer_tx_id],
			);
			for (const r of rows) requeue.add(String(r.statement_id));
		}
		const { rowCount } = await q(
			`UPDATE ${T("transactions")} SET status = 'merged', duplicate_of = $2, duplicate_entry_id = $3, bill_id = NULL, transfer_tx_id = NULL, transfer_entry_id = NULL
			  WHERE id = $1 AND status = 'new'`,
			[merge.id, keep?.id ?? null, entryId],
		);
		if (rowCount === 0) throw new ctx.HttpError(409, "this row changed; reload");
		// The journal entry it duplicates shows this bank line too.
		if (entryId) await linkEntry(entryId, { ...txLink(merge.id, merge.statement_id, merge.filename, merge.description), label: `${merge.filename} · ${merge.description} (same transaction)`.replace(/\s+/g, " ").slice(0, 200) }, req.user);
		ctx.log.info("duplicate merged", { tx: String(merge.id), keep: keep ? String(keep.id) : null, entry: entryId, by: req.user.username });
		await requeueStatements([...requeue]);
		await bills.autoMatch();
		await transfers.matchTransfers();
		for (const sid of new Set([String(merge.statement_id), ...(keep ? [String(keep.statement_id)] : [])])) await syncStatementNotice(sid);
		await refresh();
		return { merged: merge.id, keep: keep?.id ?? null, entry_id: entryId };
	});

	// POST /duplicates/dismiss {tx_id, other_id} or {tx_id, entry_id}: they aren't duplicates.
	ctx.route("POST", "/duplicates/dismiss", async (req) => {
		const b = req.body ?? {};
		const tx = await row(b.tx_id, "tx_id");
		if (b.other_id !== undefined) {
			const other = await row(b.other_id, "other_id");
			const [lo, hi] = BigInt(tx.id) < BigInt(other.id) ? [tx.id, other.id] : [other.id, tx.id];
			await q(`INSERT INTO ${T("not_duplicates")} (tx_id, other_id, created_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [lo, hi, req.user.username]);
		} else if (b.entry_id !== undefined) {
			if (!Number.isSafeInteger(Number(b.entry_id)) || Number(b.entry_id) <= 0) throw bad("entry_id must be a journal entry id");
			await q(`INSERT INTO ${T("not_duplicates")} (tx_id, entry_id, created_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [tx.id, String(b.entry_id), req.user.username]);
		} else throw bad("other_id or entry_id is required");
		await refresh();
	});

	// POST /transactions/:id/unmerge: a merged row comes back to be reviewed and posted.
	ctx.route("POST", "/transactions/:id/unmerge", async (req) => {
		const tx = await row(req.params.id, "id");
		if (tx.status !== "merged") throw new ctx.HttpError(409, `transaction ${tx.id} isn't merged`);
		await q(`UPDATE ${T("transactions")} SET status = 'new', duplicate_of = NULL, duplicate_entry_id = NULL WHERE id = $1 AND status = 'merged'`, [tx.id]);
		if (tx.duplicate_entry_id) await ctx.ledger.unlinkJournalEntry(tx.duplicate_entry_id, `tx:${tx.id}`).catch(() => false);
		await bills.autoMatch();
		await transfers.matchTransfers();
		await syncStatementNotice(tx.statement_id);
		await refresh();
		return { id: tx.id, status: "new" };
	});

	return { refresh };
}

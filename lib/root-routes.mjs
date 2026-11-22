// Root mode (Ledger 0.21.1): an admin with root mode on can delete or change any of Auto sort's
// records, also the ones it normally protects (approved bills, posted rows). Always through
// ctx.root, which keeps each row so Ledger can put it back; never the module's own DELETE/UPDATE.
// Rows that hang off a record go first (cascaded rows wouldn't be kept), and references to it are
// cleared through ctx.root too. Nothing here posts or reverses journal entries.
import { readEntries } from "./ledger-sync.mjs";

export function registerRoot(ctx, { q, T, dash, syncStatementNotice, syncTodo, dtags }) {
	const isRoot = (req) => req?.user?.root === true;
	const needRoot = (req) => {
		if (!isRoot(req)) throw new ctx.HttpError(403, "only an admin with root mode on can do this");
	};
	const num = (id, what) => {
		if (!/^\d+$/.test(String(id ?? ""))) throw new ctx.HttpError(404, `no such ${what}`);
		return String(id);
	};
	const remove = (req, table, id, summary) => ctx.root.remove(req, table, id, summary);
	const update = (req, table, id, set, summary) => ctx.root.update(req, table, id, set, summary);
	const rowsOf = async (sql, params) => (await q(sql, params)).rows;

	/** Clears every reference to a transaction from other rows, then deletes it and what hangs off it. */
	async function removeTransaction(req, id, label) {
		for (const r of await rowsOf(`SELECT id FROM ${T("not_duplicates")} WHERE tx_id = $1 OR other_id = $1`, [id])) await remove(req, "not_duplicates", r.id, `${label}: a "not duplicates" note`);
		for (const r of await rowsOf(`SELECT id FROM ${T("duplicate_skips")} WHERE tx_id = $1 OR other_id = $1`, [id])) await remove(req, "duplicate_skips", r.id, `${label}: a skipped duplicate`);
		for (const r of await rowsOf(`SELECT id FROM ${T("transactions")} WHERE duplicate_of = $1 AND id <> $1`, [id])) await update(req, "transactions", r.id, { duplicate_of: null }, `${label}: row ${r.id} no longer points at it`);
		for (const r of await rowsOf(`SELECT id FROM ${T("transactions")} WHERE transfer_tx_id = $1 AND id <> $1`, [id])) await update(req, "transactions", r.id, { transfer_tx_id: null }, `${label}: row ${r.id} no longer points at it`);
		for (const r of await rowsOf(`SELECT id FROM ${T("match_suggestions")} WHERE (subject_kind = 'transaction' AND subject_id = $1) OR (target_kind = 'transaction' AND target_id = $1)`, [id])) await remove(req, "match_suggestions", r.id, `${label}: an Auto sort match`);
		for (const r of await rowsOf(`SELECT id FROM ${T("transaction_splits")} WHERE transaction_id = $1`, [id])) await remove(req, "transaction_splits", r.id, `${label}: a split line`);
		// A bill whose stand-in line this row took (its entry isn't touched: the line stays where it is).
		for (const r of await rowsOf(`SELECT id FROM ${T("bills")} WHERE standin_tx_id = $1`, [id])) await update(req, "bills", r.id, { standin_tx_id: null }, `${label}: bill ${r.id} no longer says this row is its payment on the statement`);
		await remove(req, "transactions", id, label);
	}

	ctx.route("GET", "/root", async (req) => ({ root: isRoot(req) }));

	// Delete a statement with all its rows, posted ones too. Their journal entries stay as they are.
	ctx.route("POST", "/root/statements/:id/delete", async (req) => {
		needRoot(req);
		const id = num(req.params.id, "statement");
		const [s] = await rowsOf(`SELECT id, filename FROM ${T("statements")} WHERE id = $1`, [id]);
		if (!s) throw new ctx.HttpError(404, "no such statement");
		const label = `${ctx.name}: statement ${s.id} (${s.filename})`;
		const txs = await rowsOf(`SELECT id FROM ${T("transactions")} WHERE statement_id = $1 ORDER BY id`, [id]);
		for (const t of txs) await removeTransaction(req, t.id, `${label}, row ${t.id}`);
		for (const r of await rowsOf(`SELECT id FROM ${T("statement_files")} WHERE statement_id = $1`, [id])) await remove(req, "statement_files", r.id, `${label}: its file record`);
		for (const r of await rowsOf(`SELECT id FROM ${T("received_files")} WHERE statement_id = $1`, [id])) await update(req, "received_files", r.id, { statement_id: null }, `${label}: a received file no longer points at it`);
		for (const r of await rowsOf(`SELECT id FROM ${T("bills")} WHERE statement_id = $1`, [id])) await update(req, "bills", r.id, { statement_id: null }, `${label}: bill ${r.id} no longer points at it`);
		for (const r of await rowsOf(`SELECT id FROM ${T("inbox_files")} WHERE statement_id = $1`, [id])) await update(req, "inbox_files", r.id, { statement_id: null }, `${label}: an inbox file no longer points at it`);
		await remove(req, "statements", id, label);
		await syncStatementNotice(id).catch(() => {});
		await syncTodo?.().catch(() => {});
		return { deleted: true, rows: txs.length };
	});

	// Delete a bill or receipt, approved or paid too. Its payable entry and its document in
	// Documents stay; payment rows that pointed at it become plain rows.
	ctx.route("POST", "/root/bills/:id/delete", async (req) => {
		needRoot(req);
		const id = num(req.params.id, "bill");
		const [b] = await rowsOf(`SELECT id, kind, vendor FROM ${T("bills")} WHERE id = $1`, [id]);
		if (!b) throw new ctx.HttpError(404, "no such bill");
		const label = `${ctx.name}: ${b.kind} ${b.id}${b.vendor ? ` (${b.vendor})` : ""}`;
		for (const r of await rowsOf(`SELECT id FROM ${T("bill_lines")} WHERE bill_id = $1`, [id])) await remove(req, "bill_lines", r.id, `${label}: a split line`);
		for (const r of await rowsOf(`SELECT id FROM ${T("bill_items")} WHERE bill_id = $1`, [id])) await remove(req, "bill_items", r.id, `${label}: a line item`);
		for (const r of await rowsOf(`SELECT id FROM ${T("bill_documents")} WHERE bill_id = $1`, [id])) await remove(req, "bill_documents", r.id, `${label}: its document record`);
		for (const r of await rowsOf(`SELECT id FROM ${T("transactions")} WHERE bill_id = $1`, [id])) await update(req, "transactions", r.id, { bill_id: null }, `${label}: row ${r.id} no longer points at it`);
		for (const r of await rowsOf(`SELECT id FROM ${T("received_files")} WHERE bill_id = $1`, [id])) await update(req, "received_files", r.id, { bill_id: null }, `${label}: a received file no longer points at it`);
		for (const r of await rowsOf(`SELECT id FROM ${T("inbox_files")} WHERE bill_id = $1`, [id])) await update(req, "inbox_files", r.id, { bill_id: null }, `${label}: an inbox file no longer points at it`);
		for (const r of await rowsOf(`SELECT id FROM ${T("match_suggestions")} WHERE (subject_kind = 'bill' AND subject_id = $1) OR (target_kind = 'bill' AND target_id = $1)`, [id])) await remove(req, "match_suggestions", r.id, `${label}: an Auto sort match`);
		for (const r of await rowsOf(`SELECT id FROM ${T("duplicate_skips")} WHERE bill_id = $1`, [id])) await remove(req, "duplicate_skips", r.id, `${label}: a skipped duplicate`);
		await remove(req, "bills", id, label);
		await dash.remove(`bill-${id}`).catch(() => {});
		await syncTodo?.().catch(() => {});
		return { deleted: true };
	});

	// A posted row goes back to "new", e.g. after its entry was deleted in root mode. The entry, if
	// still there, isn't touched.
	ctx.route("POST", "/root/transactions/:id/unpost", async (req) => {
		needRoot(req);
		const id = num(req.params.id, "transaction");
		const [t] = await rowsOf(`SELECT id, status, journal_entry_id, statement_id FROM ${T("transactions")} WHERE id = $1`, [id]);
		if (!t) throw new ctx.HttpError(404, "no such transaction");
		if (t.status !== "posted") throw new ctx.HttpError(409, "this row isn't posted");
		// A row settled by a bill's entry (its stand-in line was moved to the row's account): the bill forgets it too.
		for (const r of await rowsOf(`SELECT id FROM ${T("bills")} WHERE standin_tx_id = $1`, [id])) await update(req, "bills", r.id, { standin_tx_id: null }, `${ctx.name}: bill ${r.id} no longer says row ${id} is its payment on the statement`);
		await update(req, "transactions", id, { status: "new", journal_entry_id: null, transfer_entry_id: null, posted_by: null, posted_at: null }, `${ctx.name}: row ${id} marked not posted (was entry #${t.journal_entry_id})`);
		// Its statement isn't all posted any more: the tag on the statement's document follows.
		await dtags?.syncStatement(t.statement_id).catch(() => {});
		return { status: "new" };
	});

	// A bill back to "open" without its payable entry (e.g. after that entry was deleted in root mode).
	ctx.route("POST", "/root/bills/:id/unpost", async (req) => {
		needRoot(req);
		const id = num(req.params.id, "bill");
		const [b] = await rowsOf(`SELECT id, journal_entry_id, paid_entry_id FROM ${T("bills")} WHERE id = $1`, [id]);
		if (!b) throw new ctx.HttpError(404, "no such bill");
		if (!b.journal_entry_id && !b.paid_entry_id) throw new ctx.HttpError(409, "this bill has no entry to forget");
		// With the entry, the bill forgets its stand-in line in it and the statement row linked to it (that
		// row stays posted in the entry, which isn't touched).
		await update(req, "bills", id, { journal_entry_id: null, paid_entry_id: null, paid_at: null, status: "open", standin_line: null, standin_tx_id: null }, `${ctx.name}: bill ${id} no longer in an entry (was #${b.journal_entry_id ?? b.paid_entry_id})`);
		// Its document is no longer posted or paid (Ledger's tags on files).
		await dtags?.clearPaid(id).catch(() => {});
		const [now] = await rowsOf(`SELECT id, kind, status, due_date::text AS due_date, journal_entry_id, paid_entry_id FROM ${T("bills")} WHERE id = $1`, [id]);
		if (now) await dtags?.syncBill(now).catch(() => {});
		return { status: "open" };
	});

	// Leaving root mode: what's truly broken. Rows and bills that say they're in a journal entry
	// that no longer exists (deleted in root mode and not put back).
	ctx.root?.onCheck?.(async () => {
		const posted = await rowsOf(`SELECT id, statement_id, journal_entry_id FROM ${T("transactions")} WHERE status = 'posted' AND journal_entry_id IS NOT NULL`, []);
		const billed = await rowsOf(`SELECT id, vendor, COALESCE(journal_entry_id, paid_entry_id) AS entry_id FROM ${T("bills")} WHERE COALESCE(journal_entry_id, paid_entry_id) IS NOT NULL`, []);
		const entries = await readEntries(ctx, [...posted.map((t) => t.journal_entry_id), ...billed.map((b) => b.entry_id)]);
		const problems = [];
		for (const t of posted) if (!entries.has(String(t.journal_entry_id))) problems.push(`${ctx.name}: statement ${t.statement_id}, row ${t.id} says it is posted in entry #${t.journal_entry_id}, which no longer exists (put the entry back, or mark the row not posted).`);
		for (const b of billed) if (!entries.has(String(b.entry_id))) problems.push(`${ctx.name}: bill ${b.id}${b.vendor ? ` (${b.vendor})` : ""} points at entry #${b.entry_id}, which no longer exists (put the entry back, or take the bill out of it).`);
		// A bill that says a statement row took its stand-in line, while that row isn't posted in the bill's entry.
		const linked = await rowsOf(
			`SELECT b.id, b.vendor, b.standin_tx_id, b.journal_entry_id FROM ${T("bills")} b LEFT JOIN ${T("transactions")} t ON t.id = b.standin_tx_id
			  WHERE b.standin_tx_id IS NOT NULL AND (t.id IS NULL OR t.status <> 'posted' OR t.journal_entry_id IS DISTINCT FROM b.journal_entry_id)`,
			[],
		);
		for (const b of linked) problems.push(`${ctx.name}: bill ${b.id}${b.vendor ? ` (${b.vendor})` : ""} says statement row ${b.standin_tx_id} is its payment on the card's or loan's statement, but that row isn't posted in the bill's entry${b.journal_entry_id ? ` #${b.journal_entry_id}` : ""} (unlink the row on the bill, or mark it posted there again).`);
		return problems.slice(0, 50);
	});
}

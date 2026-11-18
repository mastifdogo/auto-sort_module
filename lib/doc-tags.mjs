// Ledger's tags on files (ctx.documents.tags, Ledger 0.27.0): one tag system for documents, shared
// by Ledger and every module, the same shape as the tags on journal entries (lib/tags.mjs).
//
// - A bill's or receipt's document is "posted" while it is in the books (the note names the entry:
//   the payable entry made on approval, else the entry its payment is recorded in), "paid" while
//   the bill is paid, and "overdue" while an approved bill is past its due date.
// - A statement's document is "posted" once every one of its lines is dealt with and at least one
//   is posted (the note says how many entries).
// - A tag belongs to the document: a person (on the Documents page) or another module can set
//   "paid" on a bill's document (the bill is then paid here too, and nothing is posted) or take it
//   off (unpaid again, unless its payment is in the journal). "posted" taken off a document that
//   is in the books is put back. Tags this module didn't set are otherwise left alone.
//
// "extracted" is Ledger's own: it is on a document exactly while what was read out of it is kept
// (lib/extraction.mjs). On a Ledger without file tags every function here does nothing.

const today = () => new Date().toISOString().slice(0, 10);

/**
 * What a bill's document should say (pure). b: { kind, status, due_date, journal_entry_id,
 * paid_entry_id }. → { posted: note | null, paid: boolean, overdue: boolean }
 */
export function billDocumentTags(b, now = today()) {
	const entry = b.journal_entry_id ?? b.paid_entry_id ?? null;
	const paid = b.status === "paid";
	return {
		posted: entry === null || b.status === "ignored" ? null : `entry ${entry}${b.journal_entry_id && b.paid_entry_id ? `, paid by entry ${b.paid_entry_id}` : ""}`,
		paid,
		overdue: !paid && b.kind === "bill" && b.status === "open" && !!b.due_date && String(b.due_date).slice(0, 10) < now,
	};
}

/**
 * What a statement's document should say (pure). counts: { posted, open } (lines posted, lines
 * still to deal with). → { posted: note | null }
 */
export function statementDocumentTags({ posted = 0, open = 0, entries = [] } = {}) {
	if (Number(posted) === 0 || Number(open) > 0) return { posted: null };
	const ids = [...new Set(entries.map(String))];
	return { posted: ids.length === 1 ? `entry ${ids[0]}` : `${ids.length || posted} entries` };
}

export function documentTags(ctx, { q, T }) {
	const api = ctx.documents?.tags;
	const on = !!api && typeof api.set === "function" && typeof api.of === "function";
	const warn = (what, documentId, tag, err) => ctx.log.warn(what, { document: String(documentId), tag, err: String(err?.message || err) });

	/** Tags a document; never fails the work that led to it. */
	async function set(documentId, tag, note = "", user) {
		if (!on || documentId === null || documentId === undefined) return false;
		try {
			await api.set(documentId, tag, note ? { note: String(note).slice(0, 200) } : {}, user);
			return true;
		} catch (err) {
			warn("document not tagged", documentId, tag, err);
			return false;
		}
	}
	async function remove(documentId, tag) {
		if (!on || documentId === null || documentId === undefined) return false;
		try {
			await api.remove(documentId, tag);
			return true;
		} catch (err) {
			warn("document tag not removed", documentId, tag, err);
			return false;
		}
	}
	/** The document's tags, or null when it can't be read (gone from Documents, or no file tags in this Ledger). */
	async function of(documentId) {
		if (!on || documentId === null || documentId === undefined) return null;
		try {
			return await api.of(documentId);
		} catch {
			return null;
		}
	}
	const whoSet = (t) => (t?.module_id ? `module ${t.module_id}` : t?.set_by || "a person");

	async function billDocument(billId) {
		const { rows } = await q(`SELECT document_id FROM ${T("bill_documents")} WHERE bill_id = $1 AND document_id IS NOT NULL`, [String(billId)]);
		return rows[0]?.document_id ?? null;
	}

	/** Someone else tagged the bill's document "paid": the bill is paid here too. Nothing is posted. */
	async function paidElsewhere(billId, by) {
		const { rowCount } = await q(
			`UPDATE ${T("bills")} SET status = 'paid', paid_at = now(), paid_by_tag = true, paid_tag_by = $2, updated_at = now() WHERE id = $1 AND status IN ('new', 'open')`,
			[billId, String(by || "a person").slice(0, 100)],
		);
		return rowCount > 0;
	}

	/**
	 * Brings the tags on a bill's document in line with the bill. A "paid" someone else put on the
	 * document of an unpaid bill makes the bill paid instead. b: a bills row (id, kind, status,
	 * due_date, journal_entry_id, paid_entry_id; document_id when the caller has it). Returns "paid"
	 * when the bill became paid that way.
	 */
	async function syncBill(b, user) {
		if (!on) return null;
		const doc = b.document_id ?? (await billDocument(b.id));
		if (doc === null || doc === undefined) return null;
		const tags = await of(doc);
		if (!tags) return null;
		const has = (tag) => tags.find((t) => t.tag === tag);
		let bill = b;
		let became = null;
		const paid = has("paid");
		if (paid && paid.module_id !== ctx.id && ["new", "open"].includes(b.status) && (await paidElsewhere(b.id, whoSet(paid)))) {
			bill = { ...b, status: "paid" };
			became = "paid";
		}
		const want = billDocumentTags(bill);
		const posted = has("posted");
		if (want.posted !== null && (!posted || (posted.module_id === ctx.id && posted.note !== want.posted))) await set(doc, "posted", want.posted, user);
		if (want.posted === null && posted?.module_id === ctx.id) await remove(doc, "posted");
		if (want.paid && !paid) await set(doc, "paid", bill.paid_entry_id ? `entry ${bill.paid_entry_id}` : "", user);
		if (!want.paid && paid?.module_id === ctx.id) await remove(doc, "paid");
		const overdue = has("overdue");
		if (want.overdue && !overdue) await set(doc, "overdue", bill.due_date ? `due ${String(bill.due_date).slice(0, 10)}` : "", user);
		if (!want.overdue && overdue?.module_id === ctx.id) await remove(doc, "overdue");
		return became;
	}

	/** The bill is no longer paid (a person reopened it, or its entry's "paid" tag was taken off): so is its document. */
	async function clearPaid(billId) {
		const doc = await billDocument(billId);
		if (doc !== null) await remove(doc, "paid");
	}

	/** A bill is deleted but its document stays (someone else filed it): what this module tagged goes. */
	async function clearBill(documentId) {
		const tags = await of(documentId);
		for (const t of tags ?? []) if (["posted", "paid", "overdue"].includes(t.tag) && t.module_id === ctx.id) await remove(documentId, t.tag);
	}

	/** "posted" on a statement's document once all its lines are dealt with (and taken off again when one isn't). */
	async function syncStatement(statementId, user) {
		if (!on) return null;
		const { rows: f } = await q(`SELECT document_id FROM ${T("statement_files")} WHERE statement_id = $1 AND document_id IS NOT NULL`, [String(statementId)]);
		const doc = f[0]?.document_id ?? null;
		if (doc === null) return null;
		const { rows } = await q(
			`SELECT count(*) FILTER (WHERE status = 'posted')::int AS posted, count(*) FILTER (WHERE status IN ('new', 'posting'))::int AS open,
			        COALESCE(array_agg(DISTINCT journal_entry_id::text) FILTER (WHERE status = 'posted' AND journal_entry_id IS NOT NULL), '{}') AS entries
			   FROM ${T("transactions")} WHERE statement_id = $1`,
			[String(statementId)],
		);
		const want = statementDocumentTags(rows[0] ?? {});
		const tags = await of(doc);
		if (!tags) return null;
		const posted = tags.find((t) => t.tag === "posted");
		if (want.posted !== null && (!posted || (posted.module_id === ctx.id && posted.note !== want.posted))) await set(doc, "posted", want.posted, user);
		if (want.posted === null && posted?.module_id === ctx.id) await remove(doc, "posted");
		return want.posted;
	}

	/**
	 * Tags set or removed by another module or a person. after: { unlink(billId), autoMatch(),
	 * syncBillTodos(), complete(key), entryUnpaid(bill) } from the bill routes. Nothing is ever posted
	 * in reaction to a tag.
	 */
	function listen(after) {
		if (!on || typeof api.onChange !== "function") return;
		api.onChange(async (c) => {
			if (!c || c.module_id === ctx.id || !["paid", "posted"].includes(c.tag)) return;
			const { rows: bills } = await q(
				`SELECT b.id, b.kind, b.status, b.due_date::text AS due_date, b.journal_entry_id, b.paid_entry_id, d.document_id
				   FROM ${T("bills")} b JOIN ${T("bill_documents")} d ON d.bill_id = b.id WHERE d.document_id = $1 ORDER BY b.id`,
				[String(c.document_id)],
			);
			for (const b of bills) {
				if (c.tag === "posted") {
					// It is in the books whatever the tag says: the tag goes back.
					if (c.action === "removed") await syncBill(b);
				} else if (c.action === "set") {
					if (!["new", "open"].includes(b.status)) continue;
					const by = whoSet((await of(c.document_id))?.find((t) => t.tag === "paid") ?? { module_id: c.module_id });
					if (!(await paidElsewhere(b.id, by))) continue;
					await after.unlink(b.id);
					await after.complete(`bill-${b.id}`);
					await after.syncBillTodos();
					ctx.log.info("bill paid: its document was tagged paid", { bill: String(b.id), document: String(c.document_id), by });
				} else if (b.status === "paid") {
					const { rows: posted } = await q(`SELECT 1 FROM ${T("transactions")} WHERE bill_id = $1 AND status = 'posted' LIMIT 1`, [b.id]);
					if (b.paid_entry_id !== null || posted.length > 0) {
						await set(c.document_id, "paid", b.paid_entry_id ? `entry ${b.paid_entry_id}` : "");
						ctx.log.info("paid tag put back: the bill's payment is in the journal", { bill: String(b.id), document: String(c.document_id) });
						continue;
					}
					await q(`UPDATE ${T("bills")} SET status = 'open', paid_at = NULL, paid_by_tag = false, paid_tag_by = NULL, updated_at = now() WHERE id = $1 AND status = 'paid'`, [b.id]);
					await after.entryUnpaid?.(b);
					await after.autoMatch();
					ctx.log.info("bill unpaid again: the paid tag was taken off its document", { bill: String(b.id), document: String(c.document_id) });
				}
			}
			if (c.tag === "posted" && c.action === "removed") {
				const { rows: st } = await q(`SELECT statement_id FROM ${T("statement_files")} WHERE document_id = $1`, [String(c.document_id)]);
				for (const s of st) await syncStatement(s.statement_id);
			}
		});
	}

	return { on, set, remove, of, syncBill, clearPaid, clearBill, syncStatement, listen };
}

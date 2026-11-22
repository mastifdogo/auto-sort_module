// Vendor statements (0.31.0): a supplier's statement of account is recognised (by the reading of a
// document, or by a person on something read as a bill, a receipt or "not a bill"), reviewed (vendor,
// currency, date, balances and lines, as read and editable) and then reconciled against the
// vendor's own account on Ledger's Reconcile page. Nothing is ever posted for one.
//
// It shares the bills table (kind 'vendor_statement', migration 030) so that its document, the inbox
// file it came from and its vendor stay as they are when a person changes what it is. While it is
// one its status is 'ignored': no bill query matches, pays, lists or reminds of it, and every bill
// route answers 409 for it (getBill). What only a statement has is in vendor_statements and
// vendor_statement_lines.
//
// The reconciliation is Ledger's (ctx.reconcile, Ledger 0.34.0; the vendor's own account is
// ctx.entities.account, Ledger 0.31.0; both feature-detected). Only its id is kept here: whether it
// is in progress or finished, and which statement lines the books don't have, is read from Ledger
// every time. Without those features a statement is still recognised and kept, so it doesn't become
// a bill, and the page says reconciling it needs a newer Ledger.

import { MAX_LINES, addsUp, normalizeLine, reconcileInput, reconciliationState } from "./vendor-statements.mjs";
import { parseAmount, parseDate } from "./parse.mjs";

/** The day of a date Ledger hands over (a Date, or text). */
const day = (v) => (v == null ? "" : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

const EMPTY = { period_start: null, opening_balance_cents: null, closing_balance_cents: null, lines: [] };

/** h: the bill helpers of server.mjs ({ q, T, bad, files, dtags, tags }); bills: what registerBills returns. */
export function registerVendorStatements(ctx, h, bills) {
	const { q, T, bad } = h;
	const reconcileOn = ["start", "open", "list"].every((k) => typeof ctx.reconcile?.[k] === "function");
	const ownAccounts = typeof ctx.entities?.account === "function";
	/** Whether a statement can be reconciled here, and if not, why (for the page). */
	const can = () =>
		reconcileOn && ownAccounts
			? { available: true, reason: "" }
			: { available: false, reason: `Reconciling a vendor statement needs Ledger 0.34.0 or later (this is Ledger ${String(ctx.ledgerVersion || "").replace(/^v/, "") || "an older version"}). Until then it is kept here as a vendor statement, so it isn't taken for a bill.` };

	const COLUMNS = `b.id, b.vendor, b.vendor_entity_id, b.currency, b.bill_date::text AS statement_date, b.summary, b.error, b.confidence, b.source, b.mail_from, b.mail_subject,
		b.created_at, b.updated_at, b.updated_by,
		v.period_start::text AS period_start, v.opening_balance_cents, v.closing_balance_cents, v.reconciliation_id, v.started_by, v.read_by, v.was_kind, v.was_status,
		d.document_id, (d.bill_id IS NOT NULL) AS has_document, d.file_name AS document_name,
		(SELECT count(*)::int FROM ${T("vendor_statement_lines")} l WHERE l.bill_id = b.id) AS line_count`;
	const FROM = `FROM ${T("bills")} b JOIN ${T("vendor_statements")} v ON v.bill_id = b.id LEFT JOIN ${T("bill_documents")} d ON d.bill_id = b.id`;

	async function get(id) {
		if (!/^\d{1,18}$/.test(String(id))) throw new ctx.HttpError(404, "no such vendor statement");
		const { rows } = await q(`SELECT ${COLUMNS} ${FROM} WHERE b.id = $1 AND b.kind = 'vendor_statement'`, [String(id)]);
		if (rows.length === 0) throw new ctx.HttpError(404, "no such vendor statement");
		return rows[0];
	}

	async function linesOf(id) {
		const { rows } = await q(`SELECT id, line_no, line_date::text AS date, description, amount_cents FROM ${T("vendor_statement_lines")} WHERE bill_id = $1 ORDER BY line_no, id`, [String(id)]);
		return rows;
	}

	async function writeLines(id, lines) {
		await q(`DELETE FROM ${T("vendor_statement_lines")} WHERE bill_id = $1`, [String(id)]);
		let n = 0;
		for (const l of lines) {
			await q(`INSERT INTO ${T("vendor_statement_lines")} (bill_id, line_no, line_date, description, amount_cents) VALUES ($1, $2, $3, $4, $5)`, [String(id), ++n, l.date, l.description, l.amount_cents.toString()]);
		}
	}

	// -----------------------------------------------------------------------
	// Recognised by the reading of a document (lib/bill-routes.mjs: ingest)
	// -----------------------------------------------------------------------

	/** What stands in for a reading when a person said "vendor statement" and the AI couldn't read the file. */
	const unread = (note) => ({ kind: "vendor_statement", vendor: "", invoice_number: "", bill_date: null, due_date: null, amount_cents: null, currency: "", account_code: null, confidence: null, summary: "", items: [], statement: { ...EMPTY }, note });

	/**
	 * Keeps a document as a vendor statement. email: the parsed email (or the stand-in for a file);
	 * x: the reading (extractBill's, with x.statement when it was read as one); fileDoc / doc: its
	 * file, as for a bill. Returns the row's id (the bills id). Only an existing vendor of Ledger's
	 * list is linked here: the AI read the name; a person saving it adds a new one.
	 */
	async function create(email, x, { source, fileDoc = null, doc = null, user, readBy = "ai", saidByPerson = false }) {
		const st = x.statement ?? EMPTY;
		const notes = [];
		if (x.note) notes.push(x.note);
		else if (x.kind !== "vendor_statement") notes.push(`This was read as ${x.kind === "not_bill" ? "something that isn't a bill" : `a ${x.kind}`}, not as a statement of account; check the details and add its lines.`);
		else if (st.lines.length === 0) notes.push("No lines were read from this statement; add them by hand.");
		if (x.kind === "vendor_statement" && st.closing_balance_cents == null && !x.note) notes.push("The balance wasn't read; enter it.");
		if (x.currency === "other") notes.push("The statement is in a currency Ledger doesn't use.");
		const { rows } = await q(
			`INSERT INTO ${T("bills")} (kind, status, vendor, bill_date, currency, confidence, summary, error, source, message_id, mail_from, mail_subject, mail_date, body_text)
			 VALUES ('vendor_statement', 'ignored', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
			[
				x.vendor ?? "",
				x.bill_date ?? null,
				x.currency === "USD" ? "USD" : "CAD",
				x.confidence ?? null,
				x.summary ?? "",
				notes.join(" ") || null,
				source,
				email.messageId ?? null,
				String(email.from ?? "").slice(0, 300),
				String(email.subject ?? "").slice(0, 500),
				email.date ?? null,
				String(email.text ?? "").slice(0, 50_000),
			],
		);
		const id = rows[0].id;
		await q(`INSERT INTO ${T("vendor_statements")} (bill_id, period_start, opening_balance_cents, closing_balance_cents, read_by) VALUES ($1, $2, $3, $4, $5)`, [
			id,
			st.period_start ?? null,
			st.opening_balance_cents == null ? null : st.opening_balance_cents.toString(),
			st.closing_balance_cents == null ? null : st.closing_balance_cents.toString(),
			x.kind === "vendor_statement" && !x.note ? readBy : "",
		]);
		await writeLines(id, st.lines.slice(0, MAX_LINES));
		const meta = { kind: "bill", title: `${x.vendor || "Vendor"} statement${x.bill_date ? ` ${x.bill_date}` : ""}`.slice(0, 200), doc_date: x.bill_date ?? undefined };
		if (fileDoc) await h.files.saveBillFile(id, fileDoc, meta, user);
		else if (doc) await h.files.saveBillFile(id, { filename: (doc.filename || "statement.pdf").slice(0, 200), contentType: doc.contentType, data: doc.data }, meta, user);
		await bills.linkEntities(id, { create: false });
		ctx.log.info("vendor statement kept", { id: String(id), said_by_person: saidByPerson, lines: st.lines.length });
		return id;
	}

	// -----------------------------------------------------------------------
	// Its reconciliation, read from Ledger
	// -----------------------------------------------------------------------

	/** The vendor's own account in the statement's currency, if Ledger has made one (never made here). */
	async function ownAccountCode(st, cache = null) {
		if (!ownAccounts || !st.vendor_entity_id) return null;
		const key = String(st.vendor_entity_id);
		let entity = cache?.get(key);
		if (entity === undefined) {
			entity = typeof ctx.entities.get === "function" ? await ctx.entities.get(Number(st.vendor_entity_id)).catch(() => null) : null;
			cache?.set(key, entity);
		}
		return (entity?.accounts ?? []).find((a) => a.role === "vendor" && a.currency === st.currency)?.code ?? null;
	}

	/**
	 * What Ledger says about the statement's reconciliation: { state: "none" | "open" | "finished", id,
	 * href, … } (lib/vendor-statements.mjs), or state "unavailable" on a Ledger without ctx.reconcile.
	 * detail: also what the one in progress found (the statement lines the books don't have).
	 */
	async function stateOf(st, { detail = false, cache = null } = {}) {
		if (!reconcileOn || !ownAccounts) return { state: "unavailable", other_open: null };
		try {
			const code = await ownAccountCode(st, cache);
			if (!code) return { state: "none", other_open: null };
			let list = cache?.get(`list:${code}`);
			if (!list) {
				list = await ctx.reconcile.list(code);
				cache?.set(`list:${code}`, list);
			}
			const openRow = list.find((r) => r.status === "open");
			const open = detail && openRow ? await ctx.reconcile.open(code) : null;
			return { ...reconciliationState(st.reconciliation_id, list, open), account_code: code };
		} catch (err) {
			ctx.log.warn("reconciliation not read", { vendor_statement: String(st.id), err: String(err?.message || err) });
			return { state: "unknown", other_open: null, error: String(err?.message || err).slice(0, 300) };
		}
	}

	const view = (st, reconciliation) => ({
		id: st.id,
		vendor: st.vendor,
		vendor_entity_id: st.vendor_entity_id,
		currency: st.currency,
		statement_date: st.statement_date,
		period_start: st.period_start,
		opening_balance_cents: st.opening_balance_cents,
		closing_balance_cents: st.closing_balance_cents,
		line_count: st.line_count,
		summary: st.summary,
		error: st.error,
		confidence: st.confidence,
		read_by: st.read_by,
		source: st.source,
		mail_from: st.mail_from,
		mail_subject: st.mail_subject,
		was_kind: st.was_kind,
		has_document: !!st.has_document,
		document_id: st.document_id,
		document_name: st.document_name,
		created_at: st.created_at,
		updated_by: st.updated_by,
		reconciliation_id: st.reconciliation_id,
		reconciliation,
	});

	async function detail(id) {
		const st = await get(id);
		const lines = await linesOf(st.id);
		const reconciliation = await stateOf(st, { detail: true });
		const document_url = st.has_document ? await h.files.billFileUrl(st.id) : null;
		return { statement: { ...view(st, reconciliation), has_document: !!document_url, document_url, adds_up: addsUp(st, lines) }, lines, reconcile: can() };
	}

	// -----------------------------------------------------------------------
	// Routes
	// -----------------------------------------------------------------------

	// GET /vendor-statements: every vendor statement, newest first, each with the state of its reconciliation in Ledger.
	ctx.route("GET", "/vendor-statements", async () => {
		const { rows } = await q(`SELECT ${COLUMNS} ${FROM} WHERE b.kind = 'vendor_statement' ORDER BY COALESCE(b.bill_date, b.created_at::date) DESC, b.id DESC LIMIT 500`);
		const cache = new Map();
		const data = [];
		for (const st of rows) data.push(view(st, await stateOf(st, { cache })));
		return { data, reconcile: can() };
	});

	ctx.route("GET", "/vendor-statements/:id", (req) => detail(req.params.id));

	// PATCH /vendor-statements/:id {vendor?, currency?, statement_date?, period_start?, opening_balance?, closing_balance?}:
	// what was read, corrected by a person. Balances are signed decimals ("" or null: not known).
	ctx.route("PATCH", "/vendor-statements/:id", async (req) => {
		const st = await get(req.params.id);
		const b = req.body ?? {};
		const f = {};
		const s = {};
		if (b.vendor !== undefined) {
			if (typeof b.vendor !== "string" || b.vendor.length > 200) throw bad("vendor must be a string of at most 200 characters");
			f.vendor = b.vendor.trim();
		}
		if (b.currency !== undefined) {
			if (!["CAD", "USD"].includes(b.currency)) throw bad("currency must be CAD or USD");
			f.currency = b.currency;
		}
		const date = (k) => {
			if (b[k] === null || b[k] === "") return null;
			const d = typeof b[k] === "string" ? parseDate(b[k]) : null;
			if (!d) throw bad(`${k} must be a date (YYYY-MM-DD)`);
			return d;
		};
		if (b.statement_date !== undefined) f.bill_date = date("statement_date");
		if (b.period_start !== undefined) s.period_start = date("period_start");
		for (const k of ["opening_balance", "closing_balance"]) {
			if (b[k] === undefined) continue;
			if (b[k] === null || b[k] === "") s[`${k}_cents`] = null;
			else {
				const a = typeof b[k] === "string" || typeof b[k] === "number" ? parseAmount(typeof b[k] === "number" ? b[k].toFixed(2) : b[k]) : null;
				if (a === null || a > 10n ** 13n || a < -(10n ** 13n)) throw bad(`${k} must be an amount, e.g. 1250.00 (negative when the vendor owes you)`);
				s[`${k}_cents`] = a.toString();
			}
		}
		const unknown = Object.keys(b).filter((k) => !["vendor", "currency", "statement_date", "period_start", "opening_balance", "closing_balance"].includes(k));
		if (unknown.length > 0) throw bad(`unknown field ${unknown[0]}`);
		if (Object.keys(f).length + Object.keys(s).length === 0) throw bad("nothing to change: give vendor, currency, statement_date, period_start, opening_balance or closing_balance");
		const fk = Object.keys(f);
		// A person went over it: the note about how it was read ("enter the lines by hand") has done its job.
		await q(`UPDATE ${T("bills")} SET ${fk.map((k, i) => `${k} = $${i + 3}, `).join("")}error = NULL, updated_by = $2, updated_at = now() WHERE id = $1`, [st.id, req.user.username, ...fk.map((k) => f[k])]);
		const sk = Object.keys(s);
		if (sk.length > 0) await q(`UPDATE ${T("vendor_statements")} SET ${sk.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE bill_id = $1`, [st.id, ...sk.map((k) => s[k])]);
		// A person saved the vendor: it belongs in Ledger's list of customers and vendors.
		if ("vendor" in f) await bills.linkEntities(st.id, { create: true });
		return detail(st.id);
	});

	// PUT /vendor-statements/:id/lines {lines: [{date, description, amount}]}: the statement's lines as a
	// person checked them (all of them, in order). amount: signed decimal, an invoice or a charge
	// positive, a payment or a credit note negative.
	ctx.route("PUT", "/vendor-statements/:id/lines", async (req) => {
		const st = await get(req.params.id);
		const list = req.body?.lines;
		if (!Array.isArray(list)) throw bad("lines must be a list of { date, description, amount }");
		if (list.length > MAX_LINES) throw bad(`a statement has at most ${MAX_LINES} lines`);
		const lines = list.map((raw, i) => {
			if (!raw || typeof raw !== "object") throw bad(`lines[${i}] must be { date, description, amount }`);
			if (raw.description !== undefined && typeof raw.description !== "string") throw bad(`lines[${i}].description must be text`);
			const l = normalizeLine(raw);
			if (!l) throw bad(`lines[${i}] needs a date (YYYY-MM-DD) and an amount that isn't 0 (an invoice positive, a payment or a credit note negative)`);
			return l;
		});
		await writeLines(st.id, lines);
		await q(`UPDATE ${T("vendor_statements")} SET read_by = 'person' WHERE bill_id = $1`, [st.id]);
		await q(`UPDATE ${T("bills")} SET error = NULL, updated_by = $2, updated_at = now() WHERE id = $1`, [st.id, req.user.username]);
		return detail(st.id);
	});

	// POST /vendor-statements/:id/reconcile: opens Ledger's reconciliation of the vendor's own account
	// against this statement and answers with where to go (href, a page of Ledger). The module's own
	// reading goes along, so Ledger doesn't ask the AI again. An account has one reconciliation in
	// progress: when the vendor's has one already, that one is answered (already_open: true) and
	// nothing is started.
	ctx.route("POST", "/vendor-statements/:id/reconcile", async (req) => {
		const st = await get(req.params.id);
		const able = can();
		if (!able.available) throw new ctx.HttpError(409, able.reason);
		if (!st.vendor.trim()) throw bad("choose the vendor first");
		// A person starts it: the vendor is added to Ledger's list when it isn't there yet.
		if (!st.vendor_entity_id) {
			await bills.linkEntities(st.id, { create: true });
			st.vendor_entity_id = (await get(st.id)).vendor_entity_id;
		}
		if (!st.vendor_entity_id) throw new ctx.HttpError(409, `${JSON.stringify(st.vendor)} couldn't be added to Ledger's customers and vendors; add it there, then choose it here`);
		const lines = await linesOf(st.id);
		const before = await stateOf(st, { detail: false });
		if (before.state === "finished") throw new ctx.HttpError(409, `this statement was reconciled on ${day(before.finished_at) || "an earlier day"}; undo that reconciliation in Ledger to do it again`);
		const acc = await ctx.entities.account(Number(st.vendor_entity_id), "vendor", st.currency);
		const made = reconcileInput({ accountCode: acc.code, documentId: st.document_id, statement: st, lines });
		// An account has one reconciliation in progress, and start would hand that one back whatever is
		// asked: it is looked for first, so the person is told instead of taken for a new one.
		const open = await ctx.reconcile.open(acc.code);
		if (open) {
			const id = Number(open.reconciliation.id);
			let mine = st.reconciliation_id != null && String(st.reconciliation_id) === String(id);
			// Started in Ledger against this very document: it is this statement's.
			if (!mine && st.document_id != null && open.reconciliation.document_id != null && Number(open.reconciliation.document_id) === Number(st.document_id)) {
				await q(`UPDATE ${T("vendor_statements")} SET reconciliation_id = $2, started_by = $3 WHERE bill_id = $1`, [st.id, String(id), open.reconciliation.created_by ?? null]);
				mine = true;
			}
			const of = open.reconciliation.statement_date ? ` (statement of ${day(open.reconciliation.statement_date)})` : "";
			return {
				...(await detail(st.id)),
				href: open.href ?? `/reconcile/${id}`,
				reconciliation_id: id,
				already_open: true,
				message: mine ? "A reconciliation of this vendor is already in progress: this statement's." : `A reconciliation of this vendor is already in progress${of}; finish or delete it in Ledger before starting this one.`,
			};
		}
		if (made.error) throw bad(made.error);
		// Its document is the vendor's statement in Ledger's Documents (only one this module filed is changed).
		if (st.document_id != null) await h.files.updateDocument(st.document_id, { kind: "statement", entity_id: Number(st.vendor_entity_id), doc_date: st.statement_date }).catch(() => {});
		const r = await ctx.reconcile.start(made.input, req.user);
		const id = Number(r.reconciliation.id);
		await q(`UPDATE ${T("vendor_statements")} SET reconciliation_id = $2, started_by = $3 WHERE bill_id = $1`, [st.id, String(id), req.user.username]);
		// A person checked it and acted on it: a module that sent the file hears what became of it.
		await h.settleFile?.({ billId: st.id }, "done", `a vendor's statement of account: ${req.user.username} started reconciling it in Ledger`, req.user.username);
		return { ...(await detail(st.id)), href: r.href ?? `/reconcile/${id}`, reconciliation_id: id, already_open: false, message: "" };
	});

	/** The inbox file it came from says what it is now. */
	const relabel = (id, what, vendor) =>
		q(`UPDATE ${T("inbox_files")} SET sent_to = $2, updated_at = now() WHERE bill_id = $1 AND status = 'sent'`, [String(id), `${what} #${id}${vendor ? ` (${vendor})` : ""}`.slice(0, 200)]);

	/** Why a bill or receipt can't become a vendor statement any more: it has posted something. null: it can. */
	async function postedWhy(bill) {
		const what = bill.kind === "receipt" ? "receipt" : "bill";
		if (bill.journal_entry_id) return `this ${what} is posted to payables (entry #${bill.journal_entry_id}); undo the approval first`;
		if (bill.paid_entry_id) return `this ${what} is linked to journal entry #${bill.paid_entry_id} as its payment; unlink it first`;
		const { rows } = await q(`SELECT id, status FROM ${T("transactions")} WHERE (bill_id = $1 OR standin_bill_id = $1) AND status IN ('posting', 'posted') ORDER BY id LIMIT 1`, [bill.id]);
		if (rows.length > 0) return `a payment of this ${what} is posted (statement row ${rows[0].id}); a document that has posted something stays a ${what}`;
		return null;
	}

	// POST /bills/:id/vendor-statement: a person says a document read as a bill, a receipt or "not a
	// bill" is a vendor's statement of account. Only while it has posted nothing.
	ctx.route("POST", "/bills/:id/vendor-statement", async (req) => {
		const bill = await bills.getBill(req.params.id, { any: true });
		if (bill.kind === "vendor_statement") return detail(bill.id);
		const why = await postedWhy(bill);
		if (why) throw new ctx.HttpError(409, `${why}.`);
		// Statement rows offered as its payment are free again, its billable items come off, its to-do goes.
		await bills.unlink(bill.id);
		await h.tags.syncItems({ ...bill, status: "ignored" }, req.user);
		await q(
			`INSERT INTO ${T("vendor_statements")} (bill_id, closing_balance_cents, was_kind, was_status, read_by) VALUES ($1, NULL, $2, $3, '')
			 ON CONFLICT (bill_id) DO UPDATE SET was_kind = EXCLUDED.was_kind, was_status = EXCLUDED.was_status`,
			[bill.id, bill.kind, bill.status],
		);
		await q(`UPDATE ${T("bills")} SET kind = 'vendor_statement', status = 'ignored', updated_by = $2, updated_at = now() WHERE id = $1`, [bill.id, req.user.username]);
		if (bill.document_id != null) await h.dtags.clearBill(bill.document_id);
		await relabel(bill.id, "Vendor statement", bill.vendor);
		await bills.forget(bill.id);
		await bills.autoMatch();
		return detail(bill.id);
	});

	// POST /vendor-statements/:id/bill {kind?: "bill" | "receipt"}: it is a bill (or a receipt) after
	// all. It comes back as it was (Needs review when it never was one); its statement lines are kept
	// with it in case it is changed back.
	ctx.route("POST", "/vendor-statements/:id/bill", async (req) => {
		const st = await get(req.params.id);
		const kind = req.body?.kind ?? st.was_kind ?? "bill";
		if (!["bill", "receipt"].includes(kind)) throw bad('kind must be "bill" or "receipt"');
		const rec = await stateOf(st);
		if (rec.state === "open" || rec.state === "finished") {
			throw new ctx.HttpError(409, `this statement ${rec.state === "open" ? "is being reconciled" : "was reconciled"} in Ledger (reconciliation ${rec.id}); ${rec.state === "open" ? "delete" : "undo and delete"} that reconciliation there first`);
		}
		// What it was before, except "ignored" by being a statement: a bill nobody approved needs review.
		const status = ["new", "open", "paid", "ignored"].includes(st.was_status) ? st.was_status : "new";
		await q(`UPDATE ${T("bills")} SET kind = $2, status = $3, updated_by = $4, updated_at = now() WHERE id = $1`, [st.id, kind, status, req.user.username]);
		await q(`UPDATE ${T("vendor_statements")} SET reconciliation_id = NULL, started_by = NULL WHERE bill_id = $1`, [st.id]);
		await relabel(st.id, kind === "receipt" ? "Receipt" : "Bill", st.vendor);
		await bills.autoMatch();
		return bills.getBill(st.id);
	});

	// DELETE /vendor-statements/:id: the statement goes, with its lines. A reconciliation in Ledger
	// stays as it is, and so does the document it is checked against.
	ctx.route("DELETE", "/vendor-statements/:id", async (req) => {
		const st = await get(req.params.id);
		const rec = await stateOf(st);
		await h.settleFile?.({ billId: st.id }, "rejected", `deleted in ${ctx.name} by ${req.user.username}`, req.user.username);
		if (!["open", "finished", "unknown"].includes(rec.state)) await h.files.removeBillFile(st.id);
		await q(`DELETE FROM ${T("bills")} WHERE id = $1 AND kind = 'vendor_statement'`, [st.id]);
		await bills.forget(st.id);
	});

	return { create, unread, get, linesOf, stateOf, can, reconcileOn, ownAccounts };
}

// Matches in the journal and the Auto sort button.
//
// - Bills and receipts already recorded in the journal are found by amount and date (no AI) and
//   linked with one click; staged rows already in the journal come from lib/duplicate-routes.mjs.
// - Auto sort (on an open statement, bill or receipt) narrows candidates by amount and date
//   (lib/matching.mjs) and asks Ledger's LLM API which one is the same transaction. Its answers are
//   pending suggestions: nothing changes until a person approves one.

import { formatCents } from "./categorize.mjs";
import { dashboard } from "./dashboard.mjs";
import { WINDOW_DAYS, billCandidates, findBillEntryMatches, matchRequest, rowCandidates, shiftDays } from "./matching.mjs";

const ITEMS_PER_REQUEST = 20;
const MAX_ENTRIES = 2000;

export function registerJournalMatches(ctx, { q, T, bad, ai, bills, duplicates, transfers, syncStatementNotice }) {
	const dash = dashboard(ctx);

	/** Journal entries dated from..to (newest first, at most MAX_ENTRIES). */
	async function entriesBetween(from, to) {
		const out = [];
		for (let offset = 0; offset < MAX_ENTRIES; offset += 500) {
			const page = await ctx.ledger.listJournalEntries({ from, to, limit: 500, offset });
			out.push(...page);
			if (page.length < 500) break;
		}
		return out;
	}

	const OPEN_BILLS = `SELECT id, kind, status, vendor, invoice_number, bill_date::text AS bill_date, due_date::text AS due_date, amount_cents, created_at::date::text AS created
	                      FROM ${T("bills")} b
	                     WHERE b.status IN ('new', 'open') AND b.amount_cents IS NOT NULL AND b.paid_entry_id IS NULL
	                       AND NOT EXISTS (SELECT 1 FROM ${T("transactions")} t WHERE t.bill_id = b.id)`;

	/** Bills and receipts (all open ones, or one) already recorded in the journal, by amount and date. */
	async function billEntryMatches(billId = null) {
		const { rows } = await q(`${OPEN_BILLS} ${billId ? "AND b.id = $1" : ""} ORDER BY b.id`, billId ? [String(billId)] : []);
		if (rows.length === 0) return [];
		const dates = rows.flatMap((b) => [b.bill_date, b.due_date, b.created].filter(Boolean)).sort();
		const entries = await entriesBetween(shiftDays(dates[0], -10), shiftDays(dates.at(-1), 60));
		return findBillEntryMatches(rows, entries, ctx.id);
	}

	const entryView = (e) => ({ id: e.id, date: e.entry_date, description: e.description, reference: e.reference ?? "", accounts: [...new Set(e.lines.map((l) => l.account_code))] });

	// GET /journal-matches?bill_id=: bills and receipts already in the journal (no AI), to link.
	ctx.route("GET", "/journal-matches", async (req) => {
		const billId = req.query.get("bill_id");
		if (billId !== null && !/^\d+$/.test(billId)) throw bad("bill_id must be a bill id");
		const found = await billEntryMatches(billId);
		return {
			data: found.map((p) => ({ score: p.score, bill: { id: p.bill.id, kind: p.bill.kind, vendor: p.bill.vendor, invoice_number: p.bill.invoice_number, amount_cents: p.bill.amount_cents, bill_date: p.bill.bill_date, due_date: p.bill.due_date }, entry: entryView(p.entry) })),
		};
	});

	// -----------------------------------------------------------------------
	// Auto sort: the LLM picks among the candidates; people approve
	// -----------------------------------------------------------------------

	async function rejectedFor(kind, ids) {
		const { rows } = await q(
			`SELECT subject_id, target_kind, target_id FROM ${T("match_suggestions")} WHERE subject_kind = $1 AND subject_id = ANY($2::bigint[]) AND status = 'rejected'`,
			[kind, ids.map(String)],
		);
		return new Set(rows.map((r) => `${r.subject_id}:${r.target_kind[0]}${r.target_id}`));
	}

	/** Asks the LLM about items ([{ subjectKind, subjectId, item, candidates }]) and stores its picks as pending. */
	async function askAndStore(items, user) {
		if (items.length === 0) return 0;
		const { llm } = await ai();
		let stored = 0;
		for (let start = 0; start < items.length; start += ITEMS_PER_REQUEST) {
			const batch = items.slice(start, start + ITEMS_PER_REQUEST).map((it, k) => ({ ...it, i: k + 1 }));
			const { data } = await llm({ ...matchRequest(batch, formatCents), maxTokens: 4000 });
			const byI = new Map((Array.isArray(data?.results) ? data.results : []).map((r) => [Number(r.i), r]));
			for (const it of batch) {
				const r = byI.get(it.i);
				const c = r && r.match ? it.candidates.find((x) => x.id === r.match) : null;
				if (!c) continue;
				const conf = Number(r.confidence);
				const res = await q(
					`INSERT INTO ${T("match_suggestions")} (subject_kind, subject_id, target_kind, target_id, confidence, reason, created_by)
					 VALUES ($1, $2, $3, $4, $5, $6, $7)
					 ON CONFLICT (subject_kind, subject_id, target_kind, target_id) DO UPDATE
					   SET confidence = EXCLUDED.confidence, reason = EXCLUDED.reason, created_by = EXCLUDED.created_by, created_at = now(),
					       status = 'pending', error = NULL, decided_by = NULL, decided_at = NULL
					 WHERE ${T("match_suggestions")}.status IN ('pending', 'failed')`,
					[it.subjectKind, String(it.subjectId), c.kind, String(c.target_id), Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5, String(r.reason ?? "").slice(0, 300), user.username],
				);
				stored += res.rowCount;
			}
		}
		await syncTodo();
		return stored;
	}

	// POST /statements/:id/auto-sort: look for this statement's unposted rows elsewhere, with the LLM.
	ctx.route("POST", "/statements/:id/auto-sort", async (req) => {
		if (!/^\d+$/.test(req.params.id)) throw new ctx.HttpError(404, "no such statement");
		const { rows: st } = await q(`SELECT id, account_code FROM ${T("statements")} WHERE id = $1`, [req.params.id]);
		if (st.length === 0) throw new ctx.HttpError(404, "no such statement");
		if (!st[0].account_code) throw new ctx.HttpError(409, "choose the statement's account first");
		const { rows } = await q(
			`SELECT id, statement_id, account_code, tx_date::text AS date, description, memo, amount_cents FROM ${T("transactions")}
			  WHERE statement_id = $1 AND status = 'new' AND bill_id IS NULL AND transfer_tx_id IS NULL AND transfer_entry_id IS NULL ORDER BY line_no`,
			[st[0].id],
		);
		if (rows.length === 0) return { looked_at: 0, with_candidates: 0, suggestions: 0 };
		const dates = rows.map((r) => r.date).sort();
		const from = shiftDays(dates[0], -WINDOW_DAYS);
		const to = shiftDays(dates.at(-1), WINDOW_DAYS);
		const [entries, others, open] = await Promise.all([
			entriesBetween(from, to),
			q(
				`SELECT id, statement_id, account_code, tx_date::text AS date, description, amount_cents, status FROM ${T("transactions")}
				  WHERE statement_id <> $1 AND account_code <> '' AND status IN ('new', 'posted') AND tx_date BETWEEN $2 AND $3`,
				[st[0].id, from, to],
			).then((r) => r.rows),
			q(OPEN_BILLS).then((r) => r.rows),
		]);
		const rejected = await rejectedFor("transaction", rows.map((r) => r.id));
		const items = rows
			.map((r) => ({
				subjectKind: "transaction",
				subjectId: r.id,
				item: { date: r.date, description: r.description + (r.memo ? ` (${r.memo})` : ""), amount_cents: r.amount_cents, extra: `statement line on account ${r.account_code}` },
				candidates: rowCandidates(r, { entries, rows: others, bills: open }, ctx.id).filter((c) => !rejected.has(`${r.id}:${c.id}`)),
			}))
			.filter((it) => it.candidates.length > 0);
		await q(`DELETE FROM ${T("match_suggestions")} WHERE subject_kind = 'transaction' AND subject_id = ANY($1::bigint[]) AND status = 'pending'`, [rows.map((r) => String(r.id))]);
		const suggestions = await askAndStore(items, req.user);
		ctx.log.info("auto sort", { statement: String(st[0].id), rows: rows.length, with_candidates: items.length, suggestions, by: req.user.username });
		return { looked_at: rows.length, with_candidates: items.length, suggestions };
	});

	// POST /bills/:id/auto-sort: look for this bill's or receipt's payment, or its entry, with the LLM.
	ctx.route("POST", "/bills/:id/auto-sort", async (req) => {
		const bill = await bills.getBill(req.params.id);
		if (bill.amount_cents === null) throw bad("enter the amount first");
		if (bill.status === "paid" || bill.status === "ignored") throw new ctx.HttpError(409, `this ${bill.kind} is ${bill.status}`);
		const anchor = bill.bill_date ?? bill.due_date ?? new Date(bill.created_at).toISOString().slice(0, 10);
		const from = shiftDays(anchor, -10);
		const to = shiftDays(bill.due_date ?? anchor, 60);
		const [entries, { rows }] = await Promise.all([
			entriesBetween(from, to),
			q(
				`SELECT id, statement_id, account_code, tx_date::text AS date, description, amount_cents FROM ${T("transactions")}
				  WHERE status = 'new' AND bill_id IS NULL AND account_code <> '' AND tx_date BETWEEN $1 AND $2 AND amount_cents = $3`,
				[from, to, (-BigInt(bill.amount_cents)).toString()],
			),
		]);
		const rejected = await rejectedFor("bill", [bill.id]);
		const candidates = billCandidates({ ...bill, created: anchor }, { entries, rows }, ctx.id).filter((c) => !rejected.has(`${bill.id}:${c.id}`));
		await q(`DELETE FROM ${T("match_suggestions")} WHERE subject_kind = 'bill' AND subject_id = $1 AND status = 'pending'`, [bill.id]);
		const item = {
			subjectKind: "bill",
			subjectId: bill.id,
			item: { date: anchor, description: `${bill.vendor}${bill.invoice_number ? ` invoice ${bill.invoice_number}` : ""}`, amount_cents: -BigInt(bill.amount_cents), extra: `${bill.kind}${bill.due_date ? `, due ${bill.due_date}` : ""}` },
			candidates,
		};
		const suggestions = candidates.length ? await askAndStore([item], req.user) : 0;
		return { candidates: candidates.length, suggestions };
	});

	// GET /match-suggestions?statement_id= | bill_id=: Auto sort's pending matches, with what they point to.
	ctx.route("GET", "/match-suggestions", async (req) => {
		const sid = req.query.get("statement_id");
		const bid = req.query.get("bill_id");
		if ((sid !== null && !/^\d+$/.test(sid)) || (bid !== null && !/^\d+$/.test(bid))) throw bad("statement_id or bill_id must be an id");
		const { rows } = await q(
			`SELECT m.id, m.subject_kind, m.subject_id, m.target_kind, m.target_id, m.confidence, m.reason, m.status, m.created_by, m.created_at,
			        ot.tx_date::text AS t_date, ot.description AS t_description, ot.amount_cents AS t_amount, ot.account_code AS t_account, ot.statement_id AS t_statement, os.filename AS t_filename, ot.status AS t_status,
			        ob.kind AS b_kind, ob.vendor AS b_vendor, ob.invoice_number AS b_invoice, ob.amount_cents AS b_amount, COALESCE(ob.due_date, ob.bill_date)::text AS b_date
			   FROM ${T("match_suggestions")} m
			   LEFT JOIN ${T("transactions")} st ON m.subject_kind = 'transaction' AND st.id = m.subject_id
			   LEFT JOIN ${T("transactions")} ot ON m.target_kind = 'transaction' AND ot.id = m.target_id
			   LEFT JOIN ${T("statements")} os ON os.id = ot.statement_id
			   LEFT JOIN ${T("bills")} ob ON m.target_kind = 'bill' AND ob.id = m.target_id
			  WHERE m.status = 'pending' AND (m.subject_kind <> 'transaction' OR st.status = 'new')
			    AND (($1::bigint IS NOT NULL AND st.statement_id = $1) OR ($2::bigint IS NOT NULL AND m.subject_kind = 'bill' AND m.subject_id = $2) OR ($1::bigint IS NULL AND $2::bigint IS NULL))
			  ORDER BY m.id`,
			[sid, bid],
		);
		const out = [];
		for (const r of rows) {
			let target;
			if (r.target_kind === "entry") {
				const e = await ctx.ledger.getJournalEntry(r.target_id).catch(() => null);
				target = e ? { kind: "entry", id: e.id, date: e.entry_date, description: e.description, accounts: [...new Set(e.lines.map((l) => l.account_code))] } : { kind: "entry", id: r.target_id, missing: true };
			} else if (r.target_kind === "transaction") {
				target = { kind: "transaction", id: r.target_id, date: r.t_date, description: r.t_description, amount_cents: r.t_amount, account_code: r.t_account, statement_id: r.t_statement, filename: r.t_filename, status: r.t_status };
			} else target = { kind: "bill", id: r.target_id, bill_kind: r.b_kind, vendor: r.b_vendor, invoice_number: r.b_invoice, amount_cents: r.b_amount, date: r.b_date };
			out.push({ id: r.id, subject_kind: r.subject_kind, subject_id: r.subject_id, confidence: r.confidence, reason: r.reason, created_by: r.created_by, created_at: r.created_at, target });
		}
		return { data: out };
	});

	async function suggestion(id) {
		if (!/^\d+$/.test(id)) throw new ctx.HttpError(404, "no such suggestion");
		const { rows } = await q(`SELECT * FROM ${T("match_suggestions")} WHERE id = $1`, [id]);
		if (rows.length === 0) throw new ctx.HttpError(404, "no such suggestion");
		if (rows[0].status !== "pending") throw new ctx.HttpError(409, `this suggestion was already ${rows[0].status}`);
		return rows[0];
	}

	/** Two unposted rows, or a row and a posted one, on different accounts: one transfer, posted once. */
	async function linkTransfer(subjectId, targetId, user) {
		const { rows } = await q(`SELECT id, statement_id, account_code, amount_cents, status, journal_entry_id, bill_id FROM ${T("transactions")} WHERE id = ANY($1::bigint[])`, [[String(subjectId), String(targetId)]]);
		const a = rows.find((r) => String(r.id) === String(subjectId));
		const b = rows.find((r) => String(r.id) === String(targetId));
		if (!a || !b) throw new ctx.HttpError(404, "a transaction of this match is gone");
		if (a.status !== "new") throw new ctx.HttpError(409, `transaction ${a.id} is ${a.status}`);
		if (a.account_code === b.account_code || BigInt(a.amount_cents) !== -BigInt(b.amount_cents)) throw bad("a transfer needs opposite amounts on two different accounts");
		const why = (o) => `transfer with ${o.account_code} (Auto sort, approved by ${user.username})`.slice(0, 200);
		if (b.status === "posted") {
			await q(
				`UPDATE ${T("transactions")} SET transfer_entry_id = $2, suggested_code = $3, confidence = 1, source = 'transfer', reason = $4, bill_id = NULL, error = NULL WHERE id = $1 AND status = 'new'`,
				[a.id, b.journal_entry_id, b.account_code, `already in the journal: entry #${b.journal_entry_id} (${why(b)})`.slice(0, 200)],
			);
		} else if (b.status === "new") {
			for (const [x, y] of [[a, b], [b, a]]) {
				await q(
					`UPDATE ${T("transactions")} SET transfer_tx_id = $2, transfer_entry_id = NULL, suggested_code = $3, chosen_code = NULL, confidence = 1, source = 'transfer', reason = $4, bill_id = NULL, error = NULL
					  WHERE id = $1 AND status = 'new'`,
					[x.id, y.id, y.account_code, why(y)],
				);
			}
		} else throw new ctx.HttpError(409, `transaction ${b.id} is ${b.status}`);
		for (const sid of new Set([String(a.statement_id), String(b.statement_id)])) await syncStatementNotice(sid);
	}

	// POST /match-suggestions/:id/approve: a person agrees; carry it out.
	ctx.route("POST", "/match-suggestions/:id/approve", async (req) => {
		const s = await suggestion(req.params.id);
		const how = `matched by Auto sort, approved by ${req.user.username}`;
		if (s.subject_kind === "transaction") {
			if (s.target_kind === "entry") await duplicates.merge({ merge_id: String(s.subject_id), entry_id: String(s.target_id) }, req.user);
			else if (s.target_kind === "bill") await bills.matchBillTx(await bills.getBill(String(s.target_id)), s.subject_id, how);
			else {
				const { rows } = await q(`SELECT id, account_code, amount_cents FROM ${T("transactions")} WHERE id = ANY($1::bigint[])`, [[String(s.subject_id), String(s.target_id)]]);
				const a = rows.find((r) => String(r.id) === String(s.subject_id));
				const b = rows.find((r) => String(r.id) === String(s.target_id));
				if (!a || !b) throw new ctx.HttpError(404, "a transaction of this match is gone");
				if (a.account_code === b.account_code) await duplicates.merge({ merge_id: String(a.id), keep_id: String(b.id) }, req.user);
				else await linkTransfer(a.id, b.id, req.user);
			}
		} else {
			const bill = await bills.getBill(String(s.subject_id));
			if (s.target_kind === "transaction") await bills.matchBillTx(bill, s.target_id, how);
			else if (s.target_kind === "entry") await bills.linkBillEntry(bill, s.target_id, req.user);
			else throw bad("a bill can't be matched to another bill");
		}
		await q(`UPDATE ${T("match_suggestions")} SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1`, [s.id, req.user.username]);
		// The item is settled: its other pending suggestions go.
		await q(`DELETE FROM ${T("match_suggestions")} WHERE subject_kind = $1 AND subject_id = $2 AND status = 'pending'`, [s.subject_kind, s.subject_id]);
		await bills.autoMatch();
		await transfers.matchTransfers();
		await syncTodo();
		ctx.log.info("match approved", { suggestion: String(s.id), subject: `${s.subject_kind}:${s.subject_id}`, target: `${s.target_kind}:${s.target_id}`, by: req.user.username });
		return { id: s.id, status: "approved" };
	});

	// POST /match-suggestions/:id/reject: not the same transaction (not suggested again).
	ctx.route("POST", "/match-suggestions/:id/reject", async (req) => {
		const s = await suggestion(req.params.id);
		await q(`UPDATE ${T("match_suggestions")} SET status = 'rejected', decided_by = $2, decided_at = now() WHERE id = $1`, [s.id, req.user.username]);
		await syncTodo();
		return { id: s.id, status: "rejected" };
	});

	async function syncTodo() {
		const { rows } = await q(`SELECT count(*)::int AS n FROM ${T("match_suggestions")} WHERE status = 'pending'`);
		const n = rows[0].n;
		if (n > 0) {
			await dash.todo({
				key: "match-suggestions",
				title: `${n} match${n === 1 ? "" : "es"} from Auto sort to review`,
				body: `Approve or reject them on ${ctx.name}'s statements, bills and receipts.`,
				level: "info",
				link: dash.link,
			});
		} else await dash.complete("match-suggestions");
	}

	/** For Sort now: how many bills and receipts are already in the journal. */
	const refresh = async () => (await billEntryMatches()).length;

	return { refresh, billEntryMatches };
}

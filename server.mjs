// Auto sort (module id "categorizer", formerly "LLM API"): Ledger loads this file at startup and calls register(ctx).
// The module API is described in Ledger's docs/MODULE_LLM_CONTEXT.md. AI goes
// through Ledger's LLM API (ctx.llm, Settings → LLM API); options are the
// manifest's settings form (ctx.settings, the module's tab under Settings).
//
// Flow: upload a statement -> transactions are staged in this module's tables
// -> a background job asks the AI for an account per transaction -> you
// review on the module's page -> posting creates one journal entry per
// transaction through ctx.ledger.createJournalEntry and teaches a payee rule.
//
// Bills (lib/bill-routes.mjs): uploaded or sent by other modules, read by the
// LLM; transactions that pay them are matched before the LLM is asked.
// Journal matches (lib/journal-matches.mjs): staged rows, bills and receipts
// found in the journal, and the Auto sort button that asks the LLM.
// Transfers (lib/transfer-sync.mjs): the two rows of a transfer between your
// own accounts are linked and posted as one entry.

import { createHash } from "node:crypto";
import { registerBills } from "./lib/bill-routes.mjs";
import { moduleFiles } from "./lib/files.mjs";
import { dashboard } from "./lib/dashboard.mjs";
import { registerTransfers } from "./lib/transfer-sync.mjs";
import { registerReceivedFiles } from "./lib/received-files.mjs";
import { registerDuplicates } from "./lib/duplicate-routes.mjs";
import { registerJournalMatches } from "./lib/journal-matches.mjs";
import { candidateAccounts, examplesFromEntries, proposeCode, suggest } from "./lib/categorize.mjs";
import { ParseError, parseAmount, parseDate, parseStatement, payeeKey } from "./lib/parse.mjs";

const MAX_CONTENT_CHARS = 1_000_000;
/** Settings this module kept in its own table before Ledger 0.10.0 (copied to ctx.settings once, then deleted). */
const OLD_SETTINGS = ["batch_size", "review_threshold", "ap_account"];

/** @param {import("../../backend/src/module-host.ts").ModuleContext} ctx */
export default async function register(ctx) {
	const T = (name) => `${ctx.schema}.${name}`;
	const q = (sql, params) => ctx.db.query(sql, params);
	const bad = (msg) => new ctx.HttpError(422, msg);
	const dash = dashboard(ctx);
	const files = moduleFiles(ctx, { q, T });

	// -----------------------------------------------------------------------
	// Settings
	// -----------------------------------------------------------------------

	/** The options that matter for categorising, from the module's settings. */
	async function readSettings() {
		const v = await ctx.settings.get();
		const t = Number(v.review_threshold);
		const b = Number(v.batch_size);
		return {
			review_threshold: Number.isFinite(t) ? Math.min(Math.max(t, 0), 1) : 0.75,
			batch_size: Number.isFinite(b) ? Math.min(Math.max(Math.round(b), 1), 200) : 40,
		};
	}

	/** Ledger's AI for this module: a JSON call, and whether the provider reads PDFs. */
	async function ai() {
		const st = await ctx.llm.status();
		// PDFs and pictures go to Ledger's LLM connection for images (Ledger 0.11.2): Claude reads both,
		// a local vision model only pictures.
		return { llm: (req) => ctx.llm.json(req), readsPdf: st.readsPdf === true, readsImages: st.images?.configured === true, status: st };
	}

	// Journal entries link back to what they came from (Ledger 0.11.2), shown on the entry in Ledger.
	const txLink = (id, statementId, filename, description) => ({
		ref: `tx:${id}`,
		label: `${filename} · ${description}`.replace(/\s+/g, " ").trim().slice(0, 200),
		href: `/apps/${ctx.id}?statement=${statementId}`,
	});
	async function linkEntry(entryId, link, user) {
		try {
			await ctx.ledger.linkJournalEntry(entryId, link, user);
		} catch (err) {
			ctx.log.warn("journal entry link failed", { entry: String(entryId), ref: link.ref, err: String(err?.message || err) });
		}
	}

	/**
	 * Before Ledger 0.10.0 this module kept its options (and its own AI key and
	 * mail credentials) in mod_categorizer.settings. Copy the options that still
	 * exist to the module's settings (ctx.settings) once, and delete everything else there, keys included.
	 */
	async function migrateOldSettings() {
		const { rows } = await q(`SELECT key, value FROM ${T("settings")} WHERE key <> 'mail_state'`);
		if (rows.length === 0) return;
		const old = Object.fromEntries(rows.map((r) => [r.key, r.value]));
		const numbers = ["batch_size", "review_threshold"];
		const values = {};
		for (const k of OLD_SETTINGS) {
			if (old[k] === undefined) continue;
			values[k] = numbers.includes(k) ? Number(old[k]) : old[k];
		}
		for (const [k, v] of Object.entries(values)) {
			try {
				await ctx.settings.set({ [k]: v });
			} catch (err) {
				ctx.log.warn("old setting not copied", { key: k, err: String(err?.message || err) });
			}
		}
		await q(`DELETE FROM ${T("settings")} WHERE key <> 'mail_state'`);
		ctx.log.info("settings moved to the module's settings", { copied: Object.keys(values).join(","), removed: rows.length });
	}

	// -----------------------------------------------------------------------
	// Accounts and examples
	// -----------------------------------------------------------------------

	async function statementAccount(code) {
		const accounts = await ctx.ledger.listAccounts({ includeInactive: true });
		const account = accounts.find((a) => a.code === code);
		if (!account) throw bad(`no account with code ${JSON.stringify(code)}`);
		return { account, accounts };
	}

	async function loadRules() {
		const { rows } = await q(`SELECT payee_key, account_code, example, hits FROM ${T("rules")} ORDER BY updated_at DESC`);
		return rows;
	}

	async function examplesFor(account, candidates, rules) {
		const allowed = new Set(candidates.map((a) => a.code));
		const fromRules = rules.filter((r) => allowed.has(r.account_code)).slice(0, 30).map((r) => ({ description: r.example, account_code: r.account_code }));
		const entries = await ctx.ledger.listJournalEntries({ accountCode: account.code, limit: 300 });
		const seen = new Set(fromRules.map((e) => payeeKey(e.description)));
		const fromBooks = examplesFromEntries(entries, account.code, allowed).filter((e) => !seen.has(payeeKey(e.description)));
		return [...fromRules, ...fromBooks];
	}

	/** A dashboard notification per statement with transactions waiting to be posted; removed once none are left. */
	async function syncStatementNotice(id) {
		const key = `statement-${id}`;
		const { review_threshold } = await readSettings();
		const { rows } = await q(
			`SELECT s.filename, s.account_code, s.status, s.error,
			        count(t.id) FILTER (WHERE t.status = 'new')::int AS open,
			        count(t.id) FILTER (WHERE t.status = 'new' AND (COALESCE(t.chosen_code, t.suggested_code) IS NULL
			                            OR (t.chosen_code IS NULL AND COALESCE(t.confidence, 0) < $2)))::int AS review
			   FROM ${T("statements")} s LEFT JOIN ${T("transactions")} t ON t.statement_id = s.id
			  WHERE s.id = $1 GROUP BY s.id`,
			[id, review_threshold],
		);
		const s = rows[0];
		if (!s || (s.open === 0 && s.status !== "error")) return dash.remove(key, "notification");
		if (s.status === "error") {
			return dash.notify({ key, title: `${s.filename}: suggestions failed`.slice(0, 200), body: `${s.error ?? ""}\nRe-run them on the Statements tab.`.trim(), level: "danger", link: dash.link });
		}
		if (s.status === "needs_account") {
			return dash.notify({ key, title: `${s.filename}: choose its account`.slice(0, 200), body: `${s.open} transaction${s.open === 1 ? "" : "s"} from a statement are waiting. Choose which account the statement is for on the Statements tab.`, level: "warning", link: dash.link });
		}
		if (s.status === "queued" || s.status === "categorizing") return;
		await dash.notify({
			key,
			title: `${s.filename}: ${s.open} transaction${s.open === 1 ? "" : "s"} to post`.slice(0, 200),
			body: `${s.review > 0 ? `${s.review} need${s.review === 1 ? "s" : ""} review.` : "Every suggestion is confident."} Account ${s.account_code}.`,
			level: s.review > 0 ? "warning" : "info",
			link: dash.link,
		});
	}

	// -----------------------------------------------------------------------
	// Background categorisation (one statement at a time)
	// -----------------------------------------------------------------------

	let queue = Promise.resolve();
	const enqueue = (statementId, opts = {}) => {
		queue = queue
			.then(() => categorizeStatement(statementId, opts))
			.catch((err) => ctx.log.error("categorize failed", { statement: String(statementId), err: String(err?.message || err) }));
	};

	async function categorizeStatement(id, { all = false } = {}) {
		const { rows } = await q(`UPDATE ${T("statements")} SET status = 'categorizing', error = NULL WHERE id = $1 RETURNING account_code`, [id]);
		if (rows.length === 0) return;
		try {
			// Payments of known bills don't need the model.
			await bills.autoMatch();
			const cfg = await readSettings();
			const { llm } = await ai();
			const { account, accounts } = await statementAccount(rows[0].account_code);
			const candidates = candidateAccounts(accounts, account);
			const rules = await loadRules();
			const examples = await examplesFor(account, candidates, rules);
			const { rows: txs } = await q(
				`SELECT id, tx_date::text AS date, description, memo, amount_cents FROM ${T("transactions")}
				  WHERE statement_id = $1 AND status = 'new' AND bill_id IS NULL AND transfer_tx_id IS NULL AND transfer_entry_id IS NULL
				    AND ($2 OR suggested_code IS NULL OR source = 'error')
				  ORDER BY line_no`,
				[id, all],
			);
			const started = Date.now();
			const out = await suggest({
				llm,
				statementAccount: account,
				candidates,
				examples,
				rules: new Map(rules.map((r) => [r.payee_key, r])),
				transactions: txs,
				batchSize: cfg.batch_size,
			});
			const ids = [...out.keys()].map(String);
			const v = [...out.values()];
			const proposals = proposedAccounts(v, accounts, account.currency);
			await q(
				`UPDATE ${T("transactions")} t
				    SET suggested_code = u.code, confidence = u.confidence, reason = u.reason, source = u.source, error = NULL,
				        new_account = u.new_account::jsonb
				   FROM unnest($1::bigint[], $2::text[], $3::real[], $4::text[], $5::text[], $6::text[]) AS u(id, code, confidence, reason, source, new_account)
				  WHERE t.id = u.id AND t.status = 'new'`,
				[ids, v.map((s) => proposals.codeFor(s)), v.map((s) => s.confidence), v.map((s) => s.reason), v.map((s) => s.source), v.map((s) => proposals.jsonFor(s))],
			);
			// Rows that are one side of a transfer between your own accounts.
			await transfers.matchTransfers();
			// The same transactions uploaded twice, or already in the journal.
			await duplicates.refresh().catch((err) => ctx.log.warn("duplicate check failed", { err: String(err?.message || err) }));
			const failed = v.filter((s) => s.source === "error");
			const error = failed.length > 0 ? `${failed.length} of ${v.length} transactions could not be categorised: ${failed[0].reason}` : null;
			await q(`UPDATE ${T("statements")} SET status = 'ready', error = $2, categorized_at = now() WHERE id = $1`, [id, error]);
			await syncStatementNotice(id);
			ctx.log.info("statement categorized", { statement: String(id), transactions: txs.length, failed: failed.length, ms: Date.now() - started });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			await q(`UPDATE ${T("statements")} SET status = 'error', error = $2 WHERE id = $1`, [id, msg]);
			await syncStatementNotice(id);
			throw err;
		}
	}

	/**
	 * Accounts the model proposed creating. A proposal named like an existing account uses that account;
	 * the same name in one run gets one code; codes follow the chart's numbering (proposeCode).
	 */
	function proposedAccounts(results, accounts, currency) {
		const byName = new Map(accounts.filter((a) => a.is_active && a.currency === currency).map((a) => [a.name.trim().toLowerCase(), a]));
		const planned = new Map();
		const taken = new Set();
		const plan = (s) => {
			if (!s.newAccount) return null;
			const key = s.newAccount.name.toLowerCase();
			if (byName.has(key)) return { existing: byName.get(key).code };
			if (!planned.has(key)) {
				const code = proposeCode(accounts, s.newAccount.type, taken);
				taken.add(code);
				planned.set(key, { code, name: s.newAccount.name, type: s.newAccount.type, currency });
			}
			return planned.get(key);
		};
		return {
			codeFor: (s) => plan(s)?.existing ?? s.code,
			jsonFor: (s) => {
				const p = plan(s);
				return p && !p.existing ? JSON.stringify(p) : null;
			},
		};
	}

	/** Fingerprints identify a transaction across overlapping uploads (per account). */
	function fingerprintsOf(txs) {
		const occurrences = new Map();
		return txs.map((t) => {
			if (t.fitid) return createHash("sha256").update(`fitid|${t.fitid}`).digest("hex");
			const base = `${t.date}|${t.amount_cents}|${t.description.toUpperCase().replace(/\s+/g, " ")}`;
			const n = (occurrences.get(base) ?? 0) + 1;
			occurrences.set(base, n);
			return createHash("sha256").update(`${base}|${n}`).digest("hex");
		});
	}

	/**
	 * Stages a parsed statement's transactions (from an upload or another module) and starts the
	 * suggestions. account: the statement account, or null when it isn't known yet (the statement
	 * then waits as 'needs_account' until someone chooses). Transactions already staged for the
	 * account are skipped. Returns { id, transactions, duplicates }; with no new transactions the
	 * statement isn't kept (id null).
	 */
	async function stageStatement(parsed, { filename, account, flip = false, uploadedBy, mail = null, source = mail ? "email" : "upload", guess = null, document = null }) {
		const txs = parsed.transactions.map((t) => ({ ...t, amount_cents: flip ? -t.amount_cents : t.amount_cents }));
		const code = account?.code ?? "";
		const { rows } = await q(
			`INSERT INTO ${T("statements")} (filename, account_code, format, uploaded_by, status, source, message_id, mail_from, mail_subject, source_key, account_guess)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
			[
				(filename || `statement.${parsed.format}`).slice(0, 200),
				code,
				parsed.format,
				uploadedBy,
				account ? "queued" : "needs_account",
				source,
				mail?.messageId ?? null,
				(mail?.from ?? "").slice(0, 300),
				(mail?.subject ?? "").slice(0, 500),
				mail?.sourceKey ?? null,
				account ? null : guess,
			],
		);
		const id = rows[0].id;
		// The file itself (≤ 5 MB, in Ledger's storage), so the LLM can read the statement's balance later (Create bill).
		if (document && document.data.length <= 5 << 20) {
			await files.saveStatementFile(id, { filename: (filename || `statement.${parsed.format}`).slice(0, 200), contentType: document.type, data: document.data });
		}
		const { rowCount } = await q(
			`INSERT INTO ${T("transactions")} (statement_id, line_no, account_code, fingerprint, tx_date, description, memo, amount_cents, fitid)
			 SELECT $1, u.line_no, $2, u.fp, u.d, u.description, u.memo, u.amount, u.fitid
			   FROM unnest($3::int[], $4::text[], $5::date[], $6::text[], $7::text[], $8::bigint[], $9::text[])
			        AS u(line_no, fp, d, description, memo, amount, fitid)
			 ON CONFLICT (account_code, fingerprint) DO NOTHING`,
			[
				id,
				code,
				txs.map((t) => t.line),
				fingerprintsOf(txs),
				txs.map((t) => t.date),
				txs.map((t) => t.description.slice(0, 500)),
				txs.map((t) => (t.memo ?? "").slice(0, 500)),
				txs.map((t) => t.amount_cents.toString()),
				txs.map((t) => (t.fitid ?? "").slice(0, 100)),
			],
		);
		const duplicates = txs.length - rowCount;
		if (rowCount === 0) {
			await q(`DELETE FROM ${T("statements")} WHERE id = $1`, [id]);
			return { id: null, transactions: 0, duplicates };
		}
		await q(`UPDATE ${T("statements")} SET duplicates = $2 WHERE id = $1`, [id, duplicates]);
		if (account) enqueue(id);
		else await syncStatementNotice(id);
		ctx.log.info("statement staged", { statement: String(id), account: code || "(to choose)", source, transactions: rowCount, duplicates, by: uploadedBy });
		return { id, transactions: rowCount, duplicates };
	}

	const requeue = async (ids) => {
		for (const sid of ids) {
			const { rowCount } = await q(`UPDATE ${T("statements")} SET status = 'queued' WHERE id = $1 AND status IN ('ready', 'error')`, [sid]);
			if (rowCount > 0) enqueue(sid);
		}
	};
	const billHelpers = { q, T, bad, ai, requeue, stageStatement, settleFile: null, files };
	const bills = registerBills(ctx, billHelpers);
	const transfers = registerTransfers(ctx, { q, T, bad, requeue });
	const duplicates = registerDuplicates(ctx, { q, T, bad, bills, transfers, syncStatementNotice, requeue, txLink, linkEntry });
	const journal = registerJournalMatches(ctx, { q, T, bad, ai, bills, duplicates, transfers, syncStatementNotice });

	await migrateOldSettings().catch((err) => ctx.log.error("moving old settings failed", { err: String(err?.message || err) }));
	// Files kept in the database before 0.8.0 move to Ledger's storage, in the background.
	ctx.orgs
		.forEach(async (org) => {
			const n = await files.moveOldFiles();
			if (n) ctx.log.info("files moved to storage", { organization: org.id, files: n });
		})
		.catch((err) => ctx.log.warn("moving files to storage failed", { err: String(err?.message || err) }));
	// The email checker is gone (0.6.0): forget its state and its error notice in every organization.
	await ctx.orgs
		.forEach(async () => {
			await q(`DELETE FROM ${T("settings")} WHERE key = 'mail_state'`);
			await dash.remove("mail-error", "notification");
			await bills.syncBillTodos();
		})
		.catch((err) => ctx.log.warn("email checker cleanup failed", { err: String(err?.message || err) }));

	// Resume work interrupted by a restart, in every organization's books (startup runs in the main
	// books otherwise). The categorising itself isn't awaited: register must finish quickly.
	let resumed = 0;
	await ctx.orgs.forEach(async () => {
		const { rows: unfinished } = await q(`SELECT id FROM ${T("statements")} WHERE status IN ('queued', 'categorizing') ORDER BY id`);
		for (const r of unfinished) enqueue(r.id);
		resumed += unfinished.length;
		await q(
			`UPDATE ${T("transactions")} SET status = 'new', error = 'interrupted while posting; check the journal for this transaction before posting it again'
			  WHERE status = 'posting'`,
		);
	});
	const received = registerReceivedFiles(ctx, { q, T, bills });
	// Approving a bill, posting from a statement or discarding it settles the file it came from.
	bills.settleFile = billHelpers.settleFile = received.settle;

	// -----------------------------------------------------------------------
	// Routes: settings
	// -----------------------------------------------------------------------

	// GET /status: whether Ledger's LLM API is available to this module, for the page.
	ctx.route("GET", "/status", async (req) => {
		const [llm, cfg] = await Promise.all([ctx.llm.status(), readSettings()]);
		const { ap_account } = await ctx.settings.get();
		// Organizations (separate books): which one this request works in; the full list only for admins.
		const organization = await ctx.orgs.current();
		const organizations = req.user.role === "admin" ? await ctx.orgs.list() : [];
		return { name: ctx.name, llm, settings: { ...cfg, ap_account: String(ap_account ?? "") }, role: req.user.role, ledger: ctx.ledgerVersion, version: ctx.version, organization, organizations };
	});

	// POST /sort-now: match bills, receipts and transfers to the statement transactions waiting to be
	// posted, and look for staged rows, bills and receipts already in the journal (no AI).
	ctx.route("POST", "/sort-now", async () => {
		const billMatches = await bills.autoMatch();
		const transferLinks = await transfers.matchTransfers();
		const found = await journal.refresh();
		ctx.log.info("sort now", { bill_matches: billMatches, transfer_links: transferLinks, journal_matches: found });
		return { bill_matches: billMatches, transfer_links: transferLinks, journal_matches: found };
	});

	/**
	 * The debit lines for paying a split bill or receipt from this row: its lines, when the row books
	 * to the bill's own account (not payables) and they add up to the payment. Else null.
	 */
	async function splitLinesFor(billId, code, abs) {
		const bill = await bills.getBill(String(billId)).catch(() => null);
		if (!bill || bill.ap_account || bill.journal_entry_id || code !== bill.account_code) return null;
		const lines = await bills.linesOf(bill.id);
		if (lines.length < 2 || lines.reduce((s, l) => s + BigInt(l.amount_cents), 0n) !== abs) return null;
		return lines.map((l) => ({ account_code: l.account_code, debit_cents: BigInt(l.amount_cents), credit_cents: 0n, memo: l.description.slice(0, 500) }));
	}

	// POST /statements/:id/bill-draft: what the statement says is owed, read by the LLM, to edit and
	// create as a bill (nothing is saved here).
	ctx.route("POST", "/statements/:id/bill-draft", async (req) => {
		const statement = await getStatement(req.params.id);
		const { rows } = await q(`SELECT id FROM ${T("bills")} WHERE statement_id = $1 AND status <> 'ignored'`, [statement.id]);
		if (rows.length > 0) throw new ctx.HttpError(409, `this statement already has bill #${rows[0].id}`);
		return bills.statementBillDraft(statement);
	});

	// -----------------------------------------------------------------------
	// Routes: accounts, rules
	// -----------------------------------------------------------------------

	ctx.route("GET", "/accounts", async () => {
		const accounts = await ctx.ledger.listAccounts();
		return { data: accounts.map((a) => ({ code: a.code, name: a.name, type: a.type, currency: a.currency })) };
	});

	/**
	 * A bank or card account to create for a statement whose account isn't in the chart yet: named
	 * after the sender (or file) and the account number's last digits, a card if it says so.
	 */
	async function suggestStatementAccount(statement) {
		const accounts = await ctx.ledger.listAccounts({ includeInactive: true });
		const hint = String(statement.source_key ?? "").split("|")[1] ?? "";
		const display = /^\s*"?([^"<]+?)"?\s*</.exec(statement.mail_from ?? "")?.[1]?.trim();
		const domain = /@([a-z0-9-]+)\./i.exec(statement.mail_from ?? "")?.[1];
		const sender = String(statement.mail_from ?? "").startsWith("module:") ? "" : display || (domain ? domain.toUpperCase() : "");
		const base = sender || statement.filename.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ").trim() || "Bank account";
		const card = /visa|master ?card|amex|american express|credit|card/i.test(`${statement.filename} ${statement.mail_subject ?? ""} ${statement.mail_from ?? ""}`);
		const type = card ? "liability" : "asset";
		const name = `${base}${card && !/card|visa|master|amex/i.test(base) ? " card" : ""}${hint && hint !== "-" ? ` ••${hint}` : ""}`.slice(0, 100);
		return { code: proposeCode(accounts, type), name, type, currency: "CAD" };
	}

	// POST /accounts {code, name, type, currency?, description?, transaction_ids?, proposal?}: creates an
	// account in Ledger (a suggested one, as edited), then books the given rows, or every unposted row
	// the AI proposed it for (proposal: the proposed name), to it.
	ctx.route("POST", "/accounts", async (req) => {
		const b = req.body ?? {};
		const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
		const code = str(b.code, 32);
		const name = str(b.name, 100);
		if (!code) throw bad("code is required");
		if (!name) throw bad("name is required");
		if (!["asset", "liability", "equity", "revenue", "expense"].includes(b.type)) throw bad("type must be asset, liability, equity, revenue or expense");
		const ids = Array.isArray(b.transaction_ids) ? b.transaction_ids.map(String) : [];
		if (ids.some((x) => !/^\d+$/.test(x)) || ids.length > 1000) throw bad("transaction_ids must be up to 1000 transaction ids");
		const proposal = str(b.proposal, 100);
		let currency = b.currency;
		if (currency === undefined && ids.length > 0) {
			const { rows } = await q(`SELECT account_code FROM ${T("transactions")} WHERE id = $1`, [ids[0]]);
			if (rows[0]?.account_code) currency = (await ctx.ledger.getAccount(rows[0].account_code).catch(() => null))?.currency;
		}
		currency ??= "CAD";
		if (!["CAD", "USD"].includes(currency)) throw bad("currency must be CAD or USD");
		if ((await ctx.ledger.listAccounts({ includeInactive: true })).some((a) => a.code === code)) throw new ctx.HttpError(409, `account ${code} already exists; choose another code`);
		const account = await ctx.ledger.createAccount({ code, name, type: b.type, currency, description: str(b.description, 500) });
		let assigned = 0;
		if (ids.length > 0 || proposal) {
			const { rowCount } = await q(
				`UPDATE ${T("transactions")} t SET chosen_code = $1, new_account = NULL
				  WHERE t.status = 'new' AND t.account_code <> $1
				    AND (t.id = ANY($2::bigint[]) OR ($3 <> '' AND lower(t.new_account->>'name') = lower($3) AND t.chosen_code IS NULL))`,
				[code, ids, proposal],
			);
			assigned = rowCount;
		}
		ctx.log.info("account created", { code, name, type: b.type, assigned, by: req.user.username });
		return ctx.response(201, { account: { code: account.code, name: account.name, type: account.type, currency: account.currency }, assigned });
	});

	ctx.route("GET", "/rules", async () => ({ data: await q(`SELECT payee_key, account_code, example, hits, updated_by, updated_at FROM ${T("rules")} ORDER BY payee_key`).then((r) => r.rows) }));

	ctx.route("DELETE", "/rules/:key", async (req) => {
		const { rowCount } = await q(`DELETE FROM ${T("rules")} WHERE payee_key = $1`, [req.params.key]);
		if (rowCount === 0) throw new ctx.HttpError(404, "no such rule");
	});

	// -----------------------------------------------------------------------
	// Routes: statements
	// -----------------------------------------------------------------------

	const STATEMENT_SELECT = `
		SELECT s.id, s.filename, s.account_code, s.format, s.status, s.error, s.duplicates, s.uploaded_by, s.created_at, s.categorized_at,
		       s.source, s.mail_from, s.mail_subject, s.source_key, s.account_guess,
		       count(t.id)::int AS total,
		       count(t.id) FILTER (WHERE t.status = 'posted')::int AS posted,
		       count(t.id) FILTER (WHERE t.status = 'skipped')::int AS skipped,
		       min(t.tx_date)::text AS first_date, max(t.tx_date)::text AS last_date
		  FROM ${T("statements")} s LEFT JOIN ${T("transactions")} t ON t.statement_id = s.id`;

	ctx.route("GET", "/statements", async () => {
		const { rows } = await q(`${STATEMENT_SELECT} GROUP BY s.id ORDER BY s.id DESC LIMIT 200`);
		return { data: rows };
	});

	ctx.route("POST", "/statements", async (req) => {
		const b = req.body ?? {};
		const filename = typeof b.filename === "string" ? b.filename.trim().slice(0, 200) : "";
		if (typeof b.content !== "string" || b.content.trim() === "") throw bad("content (the statement file's text) is required");
		if (b.content.length > MAX_CONTENT_CHARS) throw bad("the file is too large; split it into smaller statements");
		if (typeof b.account_code !== "string" || b.account_code === "") throw bad("account_code (the bank or card account) is required");
		const dateOrder = ["auto", "mdy", "dmy"].includes(b.date_order) ? b.date_order : "auto";
		const { account } = await statementAccount(b.account_code);
		if (!account.is_active) throw bad(`account ${account.code} is inactive`);

		let parsed;
		try {
			parsed = parseStatement(b.content, { filename, dateOrder });
		} catch (err) {
			if (err instanceof ParseError) throw bad(err.message);
			throw err;
		}
		const r = await stageStatement(parsed, {
			filename,
			account,
			flip: b.flip_signs === true,
			uploadedBy: req.user.username,
			document: { data: Buffer.from(b.content, "utf8"), type: parsed.format === "csv" ? "text/csv" : "application/x-ofx" },
		});
		if (r.transactions === 0) throw new ctx.HttpError(409, `all ${r.duplicates} transactions in this file were uploaded before`);
		return ctx.response(201, { id: r.id, transactions: r.transactions, duplicates: r.duplicates, warnings: parsed.warnings.slice(0, 50) });
	});

	async function getStatement(id) {
		if (!/^\d+$/.test(id)) throw new ctx.HttpError(404, "no such statement");
		const { rows } = await q(`${STATEMENT_SELECT} WHERE s.id = $1 GROUP BY s.id`, [id]);
		if (rows.length === 0) throw new ctx.HttpError(404, "no such statement");
		return rows[0];
	}

	ctx.route("GET", "/statements/:id", async (req) => {
		const statement = await getStatement(req.params.id);
		const { rows } = await q(
			`SELECT t.id, t.line_no, t.tx_date::text AS date, t.description, t.memo, t.amount_cents, t.fitid, t.suggested_code, t.confidence, t.reason, t.source,
			        t.chosen_code, COALESCE(t.chosen_code, t.suggested_code) AS account_code, t.status, t.journal_entry_id, t.error, t.posted_by, t.posted_at,
			        t.new_account, t.duplicate_of, t.duplicate_entry_id,
			        t.bill_id, b.vendor AS bill_vendor, b.status AS bill_status,
			        t.transfer_tx_id, t.transfer_entry_id, o.account_code AS transfer_account, o.tx_date::text AS transfer_date,
			        o.description AS transfer_description, o.status AS transfer_status, o.statement_id AS transfer_statement_id
			   FROM ${T("transactions")} t LEFT JOIN ${T("bills")} b ON b.id = t.bill_id
			   LEFT JOIN ${T("transactions")} o ON o.id = t.transfer_tx_id
			  WHERE t.statement_id = $1 ORDER BY t.line_no, t.id`,
			[statement.id],
		);
		const { review_threshold } = await readSettings();
		// Card exports that show purchases as positive: offered as "flip signs" when choosing a card account.
		const flip_hint = statement.format === "csv" && rows.length > 0 && rows.filter((t) => t.amount_cents > 0n).length / rows.length > 0.6;
		const suggested_account = statement.status === "needs_account" ? await suggestStatementAccount(statement) : null;
		const { rows: made } = await q(`SELECT id, status FROM ${T("bills")} WHERE statement_id = $1 AND status <> 'ignored' ORDER BY id LIMIT 1`, [statement.id]);
		statement.bill_id = made[0]?.id ?? null;
		const { rows: docs } = await q(`SELECT 1 FROM ${T("statement_files")} WHERE statement_id = $1`, [statement.id]);
		statement.has_document = docs.length > 0;
		return { statement, transactions: rows, review_threshold, flip_hint, suggested_account };
	});

	ctx.route("POST", "/statements/:id/categorize", async (req) => {
		const statement = await getStatement(req.params.id);
		if (statement.status === "categorizing" || statement.status === "queued") throw new ctx.HttpError(409, "this statement is already being categorised");
		if (statement.status === "needs_account") throw new ctx.HttpError(409, "choose the statement's account first");
		await q(`UPDATE ${T("statements")} SET status = 'queued' WHERE id = $1`, [statement.id]);
		enqueue(statement.id, { all: req.body?.all === true });
		return ctx.response(202, { id: statement.id, status: "queued" });
	});

	// POST /statements/:id/account {account_code, flip_signs?}: choose (or change) the account of a
	// statement with nothing posted yet. For a statement from another module (or, before 0.6.0, email), the choice is remembered for
	// that sender and account number, so its next statements go there by themselves.
	ctx.route("POST", "/statements/:id/account", async (req) => {
		const statement = await getStatement(req.params.id);
		const b = req.body ?? {};
		if (typeof b.account_code !== "string" || b.account_code === "") throw bad("account_code is required");
		if (b.flip_signs !== undefined && typeof b.flip_signs !== "boolean") throw bad("flip_signs must be true or false");
		if (statement.posted > 0) throw new ctx.HttpError(409, "some transactions are already posted; the account can't change now");
		if (statement.status === "categorizing" || statement.status === "queued") throw new ctx.HttpError(409, "wait until the suggestions are done");
		const { account } = await statementAccount(b.account_code);
		if (!account.is_active || !["asset", "liability"].includes(account.type)) throw bad("choose an active bank (asset) or card (liability) account");
		const flip = b.flip_signs === true;
		// Rows this account already has (from an earlier upload) are dropped, as at upload.
		const { rows: dupes } = await q(
			`DELETE FROM ${T("transactions")} t WHERE t.statement_id = $1 AND t.status <> 'posted'
			    AND EXISTS (SELECT 1 FROM ${T("transactions")} o WHERE o.account_code = $2 AND o.fingerprint = t.fingerprint AND o.id <> t.id)
			  RETURNING t.id`,
			[statement.id, account.code],
		);
		await q(
			`UPDATE ${T("transactions")} SET account_code = $2, amount_cents = CASE WHEN $3 THEN -amount_cents ELSE amount_cents END,
			        suggested_code = NULL, confidence = NULL, reason = '', source = '', bill_id = NULL, transfer_tx_id = NULL, transfer_entry_id = NULL, error = NULL
			  WHERE statement_id = $1 AND status <> 'posted'`,
			[statement.id, account.code, flip],
		);
		const { rows } = await q(
			`UPDATE ${T("statements")} SET account_code = $2, status = 'queued', error = NULL, duplicates = duplicates + $3 WHERE id = $1 RETURNING source_key`,
			[statement.id, account.code, dupes.length],
		);
		if (rows[0]?.source_key) {
			await q(
				`INSERT INTO ${T("statement_sources")} (source_key, account_code, flip_signs, updated_by) VALUES ($1, $2, $3, $4)
				 ON CONFLICT (source_key) DO UPDATE SET account_code = EXCLUDED.account_code, flip_signs = EXCLUDED.flip_signs, updated_by = EXCLUDED.updated_by, updated_at = now()`,
				[rows[0].source_key, account.code, flip, req.user.username],
			);
		}
		const { rows: left } = await q(`SELECT count(*)::int AS n FROM ${T("transactions")} WHERE statement_id = $1`, [statement.id]);
		if (left[0].n === 0) {
			await q(`DELETE FROM ${T("statements")} WHERE id = $1`, [statement.id]);
			await syncStatementNotice(statement.id);
			return { id: statement.id, removed: true, duplicates: dupes.length };
		}
		enqueue(statement.id);
		return { id: statement.id, account_code: account.code, duplicates: dupes.length };
	});

	ctx.route("DELETE", "/statements/:id", async (req) => {
		const statement = await getStatement(req.params.id);
		// Posted rows stay so their fingerprints keep blocking duplicate uploads.
		await q(`DELETE FROM ${T("transactions")} WHERE statement_id = $1 AND status <> 'posted'`, [statement.id]);
		if (statement.posted === 0) await bills.settleFile?.({ statementId: statement.id }, "rejected", `discarded in ${ctx.name} by ${req.user.username}`, req.user.username);
		const { rows: left } = await q(`SELECT 1 FROM ${T("transactions")} WHERE statement_id = $1 LIMIT 1`, [statement.id]);
		if (left.length === 0) {
			// The statement goes (nothing of it was posted): so does its file.
			await files.removeStatementFile(statement.id);
			await q(`DELETE FROM ${T("statements")} WHERE id = $1`, [statement.id]);
		}
		await syncStatementNotice(statement.id);
	});

	// -----------------------------------------------------------------------
	// Routes: reviewing transactions
	// -----------------------------------------------------------------------

	async function updateTransactions(ids, b) {
		if (!Array.isArray(ids) || ids.length === 0 || ids.length > 5000 || !ids.every((x) => /^\d+$/.test(String(x)))) throw bad("ids must be a list of transaction ids");
		const sets = [];
		const params = [ids.map(String)];
		if (b.account_code !== undefined) {
			if (b.account_code !== null && typeof b.account_code !== "string") throw bad("account_code must be a string or null");
			if (b.account_code) {
				const accounts = await ctx.ledger.listAccounts();
				if (!accounts.some((a) => a.code === b.account_code)) throw bad(`no active account with code ${JSON.stringify(b.account_code)}`);
			}
			params.push(b.account_code || null);
			sets.push(`chosen_code = $${params.length}`);
		}
		if (b.status !== undefined) {
			if (b.status !== "new" && b.status !== "skipped") throw bad('status must be "new" or "skipped"');
			params.push(b.status);
			sets.push(`status = $${params.length}`);
		}
		if (sets.length === 0) throw bad("nothing to change: give account_code and/or status");
		const { rows, rowCount } = await q(
			`UPDATE ${T("transactions")} SET ${sets.join(", ")}, error = NULL WHERE id = ANY($1::bigint[]) AND status IN ('new', 'skipped') RETURNING statement_id`,
			params,
		);
		if (b.account_code !== undefined || b.status !== undefined) await transfers.matchTransfers();
		for (const sid of new Set(rows.map((r) => r.statement_id))) await syncStatementNotice(sid);
		return { updated: rowCount };
	}

	ctx.route("PATCH", "/transactions/:id", async (req) => updateTransactions([req.params.id], req.body ?? {}));
	ctx.route("POST", "/transactions/bulk", async (req) => updateTransactions(req.body?.ids, req.body ?? {}));

	// -----------------------------------------------------------------------
	// Routes: posting to the journal
	// -----------------------------------------------------------------------

	async function learn(description, code, username) {
		const key = payeeKey(description);
		if (key === "") return;
		await q(
			`INSERT INTO ${T("rules")} (payee_key, account_code, example, hits, updated_by) VALUES ($1, $2, $3, 1, $4)
			 ON CONFLICT (payee_key) DO UPDATE
			    SET hits = CASE WHEN ${T("rules")}.account_code = EXCLUDED.account_code THEN ${T("rules")}.hits + 1 ELSE 1 END,
			        account_code = EXCLUDED.account_code, example = EXCLUDED.example, updated_by = EXCLUDED.updated_by, updated_at = now()`,
			[key, code, description.slice(0, 200), username],
		);
	}

	ctx.route("POST", "/statements/:id/post", async (req) => {
		const statement = await getStatement(req.params.id);
		const only = req.body?.ids;
		if (only !== undefined && (!Array.isArray(only) || !only.every((x) => /^\d+$/.test(String(x))))) throw bad("ids must be a list of transaction ids");
		const { rows } = await q(
			`SELECT id FROM ${T("transactions")}
			  WHERE statement_id = $1 AND status = 'new' AND COALESCE(chosen_code, suggested_code) IS NOT NULL
			    AND ($2::bigint[] IS NULL OR id = ANY($2::bigint[]))
			  ORDER BY tx_date, line_no`,
			[statement.id, only === undefined ? null : only.map(String)],
		);
		const results = { posted: 0, already_recorded: 0, failed: [] };
		const otherStatements = new Set();
		for (const { id } of rows) {
			// Claim the row so a double click cannot post it twice.
			const claim = await q(
				`UPDATE ${T("transactions")} SET status = 'posting' WHERE id = $1 AND status = 'new'
				 RETURNING tx_date::text AS date, description, memo, amount_cents, fitid, account_code, COALESCE(chosen_code, suggested_code) AS code, bill_id, statement_id,
				           transfer_tx_id, transfer_entry_id`,
				[id],
			);
			if (claim.rowCount === 0) continue;
			const t = claim.rows[0];
			const amt = t.amount_cents;
			const abs = amt < 0n ? -amt : amt;
			const markPosted = (entryId) =>
				q(`UPDATE ${T("transactions")} SET status = 'posted', journal_entry_id = $2, posted_by = $3, posted_at = now(), error = NULL WHERE id = $1`, [
					id,
					entryId,
					req.user.username,
				]);
			try {
				// One side of a transfer that is already in the journal: nothing new to post.
				let existing = null;
				if (t.transfer_entry_id !== null) {
					const e = await ctx.ledger.getJournalEntry(t.transfer_entry_id);
					if (e.reversed_by_id) throw new Error(`the linked journal entry #${e.id} was reversed; use "Not a transfer" and post this again`);
					existing = e.id;
				} else if (t.transfer_tx_id !== null) {
					const { rows: o } = await q(`SELECT status, journal_entry_id FROM ${T("transactions")} WHERE id = $1`, [t.transfer_tx_id]);
					if (o[0]?.status === "posted" && o[0].journal_entry_id !== null) existing = o[0].journal_entry_id;
				}
				const link = txLink(id, statement.id, statement.filename, t.description);
				if (existing !== null) {
					await markPosted(existing);
					await linkEntry(existing, link, req.user);
					results.posted++;
					results.already_recorded++;
					continue;
				}
				// A split receipt (or a bill not posted to payables) books each of its lines.
				const split = t.bill_id !== null && amt < 0n ? await splitLinesFor(t.bill_id, t.code, abs) : null;
				const entry = await ctx.ledger.createJournalEntry(
					{
						entry_date: t.date,
						description: t.description.trim().slice(0, 500) || "Bank transaction",
						reference: (t.fitid || `categorizer ${statement.id}/${id}`).slice(0, 100),
						lines: [
							{ account_code: t.account_code, debit_cents: amt > 0n ? abs : 0n, credit_cents: amt < 0n ? abs : 0n, memo: t.memo.slice(0, 500) },
							...(split ?? [{ account_code: t.code, debit_cents: amt < 0n ? abs : 0n, credit_cents: amt > 0n ? abs : 0n, memo: "" }]),
						],
						links: [link],
					},
					req.user,
				);
				await markPosted(entry.id);
				// The other side of a transfer is recorded by this same entry.
				if (t.transfer_tx_id !== null) {
					const { rows: other } = await q(
						`UPDATE ${T("transactions")} SET status = 'posted', journal_entry_id = $2, posted_by = $3, posted_at = now(), error = NULL, reason = $4
						  WHERE id = $1 AND status = 'new' AND COALESCE(chosen_code, suggested_code) = $5
						  RETURNING statement_id, description, (SELECT filename FROM ${T("statements")} s WHERE s.id = statement_id) AS filename`,
						[t.transfer_tx_id, entry.id, req.user.username, `recorded with the transfer from ${t.account_code} (entry #${entry.id})`, t.account_code],
					);
					for (const r of other) {
						otherStatements.add(r.statement_id);
						await linkEntry(entry.id, txLink(t.transfer_tx_id, r.statement_id, r.filename, r.description), req.user);
					}
				}
				// A bill payment marks the bill paid; it isn't a payee rule (it books to payables).
				const paidBill = t.bill_id !== null && (await bills.onPosted(id, t.code, entry.id));
				if (paidBill) await linkEntry(entry.id, await bills.linkFor(t.bill_id), req.user);
				if (!paidBill && !split) await learn(t.description, t.code, req.user.username);
				results.posted++;
			} catch (err) {
				const msg = String(err?.message || err).slice(0, 500);
				await q(`UPDATE ${T("transactions")} SET status = 'new', error = $2 WHERE id = $1`, [id, msg]);
				results.failed.push({ id, error: msg });
			}
		}
		await syncStatementNotice(statement.id);
		for (const sid of otherStatements) if (String(sid) !== String(statement.id)) await syncStatementNotice(sid);
		// New entries can be the recorded side of transfers still waiting on other statements.
		if (results.posted > 0) await transfers.matchTransfers();
		// Someone posted from it: the file it came from (if another module sent it) is done.
		if (results.posted > 0) await bills.settleFile?.({ statementId: statement.id }, "done", `${results.posted} transaction${results.posted === 1 ? "" : "s"} posted by ${req.user.username}`, req.user.username);
		ctx.log.info("transactions posted", { statement: String(statement.id), posted: results.posted, failed: results.failed.length, by: req.user.username });
		return results;
	});

	// -----------------------------------------------------------------------
	// Route: suggestions without staging (for scripts and other modules)
	// -----------------------------------------------------------------------

	// POST /suggest {"account_code": "1000", "transactions": [{"date": "2026-03-01", "description": "SHELL", "amount": "-45.10"}]}
	ctx.route("POST", "/suggest", async (req) => {
		const b = req.body ?? {};
		if (!Array.isArray(b.transactions) || b.transactions.length === 0 || b.transactions.length > 500) throw bad("transactions must be a list of 1-500 items");
		const { account, accounts } = await statementAccount(String(b.account_code ?? ""));
		const txs = b.transactions.map((t, i) => {
			const amount = typeof t?.amount === "number" ? parseAmount(t.amount.toFixed(2)) : parseAmount(t?.amount);
			const date = parseDate(t?.date ?? "", "mdy");
			if (amount === null || !date || typeof t.description !== "string") throw bad(`transactions[${i}] needs date, description and amount`);
			return { id: i, date, description: t.description.slice(0, 500), memo: typeof t.memo === "string" ? t.memo.slice(0, 500) : "", amount_cents: amount };
		});
		const cfg = await readSettings();
		const { llm } = await ai();
		const candidates = candidateAccounts(accounts, account);
		const rules = await loadRules();
		const out = await suggest({
			llm,
			statementAccount: account,
			candidates,
			examples: await examplesFor(account, candidates, rules),
			rules: new Map(rules.map((r) => [r.payee_key, r])),
			transactions: txs,
			batchSize: cfg.batch_size,
		});
		return {
			data: txs.map((t) => {
				const s = out.get(t.id);
				return {
					index: t.id,
					account_code: s.code,
					confidence: s.confidence,
					reason: s.reason,
					source: s.source,
					new_account: s.newAccount ?? null,
					needs_review: s.code === null || s.confidence < cfg.review_threshold,
				};
			}),
		};
	});

	// -----------------------------------------------------------------------
	// Ledger's search bar: bills, statements and transactions
	// -----------------------------------------------------------------------

	const like = (s) => `%${s.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
	const money = (cents, cur) => `${(Number(cents) / 100).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur ?? ""}`.trim();
	ctx.search.provide(async (query, { limit }) => {
		const term = String(query ?? "").trim();
		if (term.length < 2) return [];
		const n = Math.min(limit, 20);
		const [b, st, tx] = await Promise.all([
			q(
				`SELECT id, vendor, invoice_number, due_date::text AS due_date, amount_cents, currency, status FROM ${T("bills")}
				  WHERE vendor ILIKE $1 OR invoice_number ILIKE $1 OR mail_subject ILIKE $1 ORDER BY id DESC LIMIT $2`,
				[like(term), n],
			),
			q(`SELECT id, filename, account_code FROM ${T("statements")} WHERE filename ILIKE $1 ORDER BY id DESC LIMIT $2`, [like(term), n]),
			q(
				`SELECT t.id, t.statement_id, t.tx_date::text AS date, t.description, t.amount_cents, t.account_code, t.status FROM ${T("transactions")} t
				  WHERE t.description ILIKE $1 OR t.memo ILIKE $1 ORDER BY t.tx_date DESC LIMIT $2`,
				[like(term), n],
			),
		]);
		return [
			...b.rows.map((r) => ({
				title: `Bill: ${r.vendor || "unknown vendor"}${r.invoice_number ? ` #${r.invoice_number}` : ""}`,
				subtitle: [r.amount_cents === null ? "" : money(r.amount_cents, r.currency), r.due_date ? `due ${r.due_date}` : "", r.status].filter(Boolean).join(" · "),
				href: `/apps/${ctx.id}?bill=${r.id}`,
			})),
			...st.rows.map((r) => ({ title: `Statement: ${r.filename}`, subtitle: `account ${r.account_code}`, href: `/apps/${ctx.id}?statement=${r.id}` })),
			...tx.rows.map((r) => ({
				title: r.description,
				subtitle: `${r.date} · ${money(r.amount_cents)} · account ${r.account_code} · ${r.status === "new" ? "to post" : r.status}`,
				href: `/apps/${ctx.id}?statement=${r.statement_id}`,
			})),
		].slice(0, limit);
	});

	ctx.log.info("module ready", { resumed });
}

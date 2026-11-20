// The hand-over from the Import module (id "downloads"), which was merged into this one in 0.17.0.
//
// Import's data lives in its own schema, mod_downloads, in each organization's database. Its last
// release moves every file it holds into Ledger's Documents and keeps the document's id; this
// module then takes over the rows: the inbox entries (with their document, status, origin, mail
// details, where they were sent), what the AI read (extractions), the email check's log and what
// it learned, its last-run state, and Import's settings. Rows only: no file is copied or moved.
//
// - Reading another module's schema is done here and nowhere else, for this one-off hand-over.
// - It moves a person's data between modules, so it happens only when an admin presses the button
//   (POST /adoption). Until then a banner on the page and a to-do on the dashboard say it waits.
// - Safe to run again: the id each adopted row had in Import is kept (adopted_ids), so it is never
//   taken twice, also after the row was deleted here: a file deleted from the inbox stays deleted.
//   Settings are copied the first time only.
// - Inbox entries whose file isn't in Documents yet (no document_id: Import wasn't updated to its
//   last release, or the file itself was lost) are counted and reported, not adopted.
// - Nothing in mod_downloads is ever changed or deleted.
// - While Import's data waits, this module's email check holds off (mailHold), so the mail Import
//   already looked at isn't imported a second time.

import { rowsData } from "./extraction.mjs";

const SRC = "mod_downloads";
const IMPORT_ID = "downloads";
const STATE_KEY = "import_adoption";
/** Import's settings that exist here under the same key. */
const SETTINGS = ["max_file_mb", "keep_days", "mail_source", "mail_interval", "mail_keywords", "mail_lookback_days", "mail_save_body", "scanner_url"];

/** h: { q, T, bad, files } → { status(), mailHold(), onAdopted(fn) } */
export function registerAdoption(ctx, { q, T, bad, files }) {
	const listeners = [];

	async function getState() {
		const { rows } = await q(`SELECT value FROM ${T("module_state")} WHERE key = $1`, [STATE_KEY]);
		return rows[0]?.value ?? {};
	}
	async function saveState(patch) {
		await q(
			`INSERT INTO ${T("module_state")} (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = ${T("module_state")}.value || EXCLUDED.value, updated_at = now()`,
			[STATE_KEY, JSON.stringify(patch)],
		);
	}

	/** Which of Import's tables exist in this organization's database (it may never have been installed). */
	async function sourceTables() {
		const { rows } = await q(
			`SELECT to_regclass($1) IS NOT NULL AS files, to_regclass($2) IS NOT NULL AS file_chunks, to_regclass($3) IS NOT NULL AS extractions,
			        to_regclass($4) IS NOT NULL AS mail_seen, to_regclass($5) IS NOT NULL AS mail_training,
			        to_regclass($6) IS NOT NULL AS email_check_state, to_regclass($7) IS NOT NULL AS state`,
			[`${SRC}.files`, `${SRC}.file_chunks`, `${SRC}.extractions`, `${SRC}.mail_seen`, `${SRC}.mail_training`, `${SRC}.email_check_state`, `${SRC}.state`],
		);
		return rows[0] ?? {};
	}
	/** The columns one of Import's tables has (older versions had fewer). */
	async function columnsOf(table) {
		const { rows } = await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`, [SRC, table]);
		return new Set(rows.map((r) => r.column_name));
	}
	const n = (v) => Number(v ?? 0);

	/** What of Import's is here to take over, and what was taken over before. */
	async function status() {
		const state = await getState();
		const base = { installed: false, old_version: false, ready: 0, waiting: 0, extractions: 0, mail_seen: 0, training: 0, has_settings: false, adopted: state.adopted_at ? state : null, dismissed: state.dismissed === true, pending: false, hold: false };
		let t;
		try {
			t = await sourceTables();
		} catch (err) {
			return { ...base, error: String(err?.message || err) };
		}
		if (!t.files) return base;
		const out = { ...base, installed: true, old_version: t.file_chunks === true };
		try {
			await seedTaken(state, t);
			const cols = await columnsOf("files");
			if (cols.has("document_id")) {
				const { rows } = await q(
					`SELECT count(*) FILTER (WHERE f.document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${T("adopted_ids")} a WHERE a.kind = 'file' AND a.source_id = f.id))::int AS ready,
					        count(*) FILTER (WHERE f.document_id IS NULL)::int AS waiting
					   FROM ${SRC}.files f WHERE f.status IN ('new', 'sent', 'archived')`,
				);
				out.ready = n(rows[0]?.ready);
				out.waiting = n(rows[0]?.waiting);
			} else {
				const { rows } = await q(`SELECT count(*)::int AS waiting FROM ${SRC}.files f WHERE f.status IN ('new', 'sent', 'archived')`);
				out.waiting = n(rows[0]?.waiting);
			}
			if (t.extractions) {
				const { rows } = await q(
					`SELECT count(*)::int AS n FROM ${SRC}.extractions e WHERE NOT EXISTS (SELECT 1 FROM ${T("adopted_ids")} a WHERE a.kind = 'extraction' AND a.source_id = e.id)
					    -- not what was read from a file that was taken over and then deleted here
					    AND (EXISTS (SELECT 1 FROM ${T("inbox_files")} i WHERE i.adopted_from = e.file_id)
					         OR NOT EXISTS (SELECT 1 FROM ${T("adopted_ids")} a WHERE a.kind = 'file' AND a.source_id = e.file_id))`,
				);
				out.extractions = n(rows[0]?.n);
			}
			if (t.mail_seen) {
				const { rows } = await q(
					`SELECT count(*)::int AS n FROM ${SRC}.mail_seen s
					  WHERE NOT EXISTS (SELECT 1 FROM ${T("mail_seen")} m WHERE m.folder = s.folder AND m.uidvalidity = s.uidvalidity AND m.uid = s.uid)`,
				);
				out.mail_seen = n(rows[0]?.n);
			}
			if (t.mail_training) {
				const { rows } = await q(`SELECT count(*)::int AS n FROM ${SRC}.mail_training s WHERE NOT EXISTS (SELECT 1 FROM ${T("adopted_ids")} a WHERE a.kind = 'training' AND a.source_id = s.id)`);
				out.training = n(rows[0]?.n);
			}
			out.has_settings = Object.keys(await importSettings()).length > 0;
		} catch (err) {
			return { ...out, error: String(err?.message || err) };
		}
		const something = out.ready > 0 || out.mail_seen > 0 || out.training > 0;
		// Waiting to be taken over: something adoptable, or (before the first time) files Import still has to move, or its settings.
		out.pending = !out.dismissed && (something || (!out.adopted && (out.waiting > 0 || out.has_settings)));
		// The email check holds off until the first hand-over (or the admin says there won't be one).
		out.hold = !out.dismissed && !out.adopted && (out.old_version || something);
		return out;
	}

	/** Import's settings in this organization, as Ledger keeps them ({} when none were ever saved). */
	async function importSettings() {
		const { rows } = await q(`SELECT "values" FROM public.module_settings WHERE module_id = $1`, [IMPORT_ID]).catch(() => ({ rows: [] }));
		const v = rows[0]?.values;
		const out = {};
		if (v && typeof v === "object") for (const k of SETTINGS) if (v[k] !== undefined && v[k] !== null) out[k] = v[k];
		return out;
	}

	/** Why the email check holds off, or "". */
	async function mailHold() {
		const st = await status().catch(() => null);
		if (!st?.hold) return "";
		return st.old_version && st.ready === 0
			? `the Import module still holds its files and its email log: update Import to its last version (Settings → Modules), then take its data over on ${ctx.name}'s Inbox tab; until then email isn't read here, so nothing is imported twice`
			: `the Import module's files and email log haven't been taken over yet (an admin does that on ${ctx.name}'s Inbox tab); until then email isn't read here, so nothing is imported twice`;
	}

	async function syncTodo() {
		try {
			const st = await status();
			if (!st.pending) return void (await ctx.dashboard.remove("import-adoption"));
			const parts = [];
			if (st.ready) parts.push(`${st.ready} file${st.ready === 1 ? "" : "s"} in its inbox`);
			if (st.mail_seen) parts.push(`its log of ${st.mail_seen} email${st.mail_seen === 1 ? "" : "s"}`);
			if (st.training) parts.push("what its email check learned");
			await ctx.dashboard.todo({
				key: "import-adoption",
				title: `Take over the Import module's data in ${ctx.name}`,
				body: `Import is part of ${ctx.name} now. ${parts.length ? `Waiting: ${parts.join(", ")}. ` : ""}${st.waiting ? `${st.waiting} of its files ${st.waiting === 1 ? "isn't" : "aren't"} in Documents yet: update the Import module first. ` : ""}An admin takes it over on the Inbox tab; nothing is deleted from Import.`.slice(0, 2000),
				link: `/apps/${ctx.id}?tab=inbox`,
			});
		} catch (err) {
			ctx.log.warn("hand-over to-do not updated", { err: String(err?.message || err) });
		}
	}

	/** Notes the Import ids of the rows just taken over, so they stay taken when the rows are deleted here later. */
	const remember = (kind, table) =>
		q(`INSERT INTO ${T("adopted_ids")} (kind, source_id) SELECT $1, adopted_from FROM ${T(table)} WHERE adopted_from IS NOT NULL ON CONFLICT DO NOTHING`, [kind]);

	/**
	 * Once, for a hand-over done before taken ids were kept apart (0.17.0): files deleted from the
	 * inbox since then left no trace and would look like Import's again. That hand-over took every
	 * file Import had in Documents, so those all count as taken (when some were still waiting to be
	 * moved then, only the ones up to the last id taken, so the rest can still come over).
	 */
	async function seedTaken(state, t) {
		if (state.taken_seeded === true) return;
		if (state.adopted_at && t.files) {
			const cols = await columnsOf("files");
			if (cols.has("document_id")) {
				await q(
					`INSERT INTO ${T("adopted_ids")} (kind, source_id)
					 SELECT 'file', f.id FROM ${SRC}.files f
					  WHERE f.status IN ('new', 'sent', 'archived') AND f.document_id IS NOT NULL
					    AND ($1 OR f.id <= (SELECT coalesce(max(source_id), 0) FROM ${T("adopted_ids")} WHERE kind = 'file'))
					 ON CONFLICT DO NOTHING`,
					[n(state.waiting) === 0],
				);
			}
			if (t.extractions) await q(`INSERT INTO ${T("adopted_ids")} (kind, source_id) SELECT 'extraction', e.id FROM ${SRC}.extractions e ON CONFLICT DO NOTHING`);
			if (t.mail_training) await q(`INSERT INTO ${T("adopted_ids")} (kind, source_id) SELECT 'training', s.id FROM ${SRC}.mail_training s ON CONFLICT DO NOTHING`);
		}
		await saveState({ taken_seeded: true });
	}

	/** Takes over what can be taken over. Returns what was adopted and what still waits. */
	async function adopt(user) {
		const t = await sourceTables();
		await seedTaken(await getState(), t);
		if (!t.files) throw new ctx.HttpError(409, "the Import module's data isn't in this organization: there is nothing to take over");
		const cols = await columnsOf("files");
		const result = { files: 0, extractions: 0, extractions_saved: 0, mail_seen: 0, mail_training: 0, settings: [], waiting: 0, linked: 0 };
		/** A column of Import's files table, or a default when that version didn't have it. */
		const c = (name, fallback) => (cols.has(name) ? `f.${name}` : fallback);

		if (cols.has("document_id")) {
			// Rows only: each entry keeps the document Import filed it as. An entry deleted from Documents
			// since, or never moved there, has no document_id and stays in Import (counted below).
			const { rows } = await q(
				`INSERT INTO ${T("inbox_files")} (name, content_type, size_bytes, sha256, status, document_id, document_added_here, origin, origin_detail, source_url, note, account_code,
				                                 received_by, received_at, sent_to, sent_link, sent_by, sent_at, mail_features, mail_trained, mail_folder, mail_uid, adopted_from, updated_at)
				 SELECT f.name, f.content_type, f.size_bytes, f.sha256, f.status, f.document_id, false, ${c("origin", "''")}, ${c("origin_detail", "''")}, f.source_url, f.note, ${c("account_code", "''")},
				        f.received_by, f.received_at, f.sent_to, f.sent_link, f.sent_by, f.sent_at, ${c("mail_features", "NULL::text[]")}, ${c("mail_trained", "false")}, ${c("mail_folder", "''")}, ${c("mail_uid", "''")}, f.id, f.updated_at
				   FROM ${SRC}.files f
				  WHERE f.status IN ('new', 'sent', 'archived') AND f.document_id IS NOT NULL
				    AND NOT EXISTS (SELECT 1 FROM ${T("adopted_ids")} a WHERE a.kind = 'file' AND a.source_id = f.id)
				  ORDER BY f.id
				 RETURNING id`,
			);
			result.files = rows.length;
			await remember("file", "inbox_files");
			// "Sent to" links that pointed into Import's page point here now.
			await q(
				`UPDATE ${T("inbox_files")} a SET sent_link = $1 || b.id
				   FROM ${T("inbox_files")} b
				  WHERE a.adopted_from IS NOT NULL AND b.adopted_from IS NOT NULL AND a.sent_link = $2 || b.adopted_from`,
				[`/apps/${ctx.id}?file=`, `/apps/${IMPORT_ID}?file=`],
			);
			await q(`UPDATE ${T("inbox_files")} SET sent_link = $1 WHERE adopted_from IS NOT NULL AND (sent_link = $2 OR sent_link LIKE $3)`, [`/apps/${ctx.id}?tab=inbox`, `/apps/${IMPORT_ID}`, `/apps/${IMPORT_ID}?%`]);
			// Files Import handed to this module before: the inbox entry knows the statement or bill it became.
			if (cols.has("sent_file_id")) {
				const { rowCount } = await q(
					`UPDATE ${T("inbox_files")} i SET statement_id = r.statement_id, bill_id = r.bill_id
					   FROM ${SRC}.files f JOIN ${T("received_files")} r ON r.file_id = f.sent_file_id
					  WHERE i.adopted_from = f.id AND i.statement_id IS NULL AND i.bill_id IS NULL AND (r.statement_id IS NOT NULL OR r.bill_id IS NOT NULL)`,
				);
				result.linked = rowCount;
			}
			const { rows: w } = await q(`SELECT count(*)::int AS n FROM ${SRC}.files f WHERE f.status IN ('new', 'sent', 'archived') AND f.document_id IS NULL`);
			result.waiting = n(w[0]?.n);
		} else {
			const { rows: w } = await q(`SELECT count(*)::int AS n FROM ${SRC}.files f WHERE f.status IN ('new', 'sent', 'archived')`);
			result.waiting = n(w[0]?.n);
		}

		if (t.extractions) {
			const ecols = await columnsOf("extractions");
			const tx = ecols.has("transactions") ? "e.transactions" : "e.rows";
			const { rows } = await q(
				`INSERT INTO ${T("inbox_extractions")} (file_id, status, model, currency, instructions, transactions, created_by, created_at, decided_by, decided_at, adopted_from)
				 SELECT i.id, e.status, e.model, e.currency, e.instructions, ${tx}, e.created_by, e.created_at, e.decided_by, e.decided_at, e.id
				   FROM ${SRC}.extractions e JOIN ${T("inbox_files")} i ON i.adopted_from = e.file_id
				  WHERE NOT EXISTS (SELECT 1 FROM ${T("adopted_ids")} a WHERE a.kind = 'extraction' AND a.source_id = e.id)
				  ORDER BY e.id
				 RETURNING id, status, currency, transactions, decided_by, (SELECT document_id FROM ${T("inbox_files")} f WHERE f.id = file_id) AS document_id`,
			);
			result.extractions = rows.length;
			await remember("extraction", "inbox_extractions");
			if (ecols.has("csv_file_id")) {
				await q(
					`UPDATE ${T("inbox_extractions")} x SET csv_file_id = i.id
					   FROM ${SRC}.extractions e JOIN ${T("inbox_files")} i ON i.adopted_from = e.csv_file_id
					  WHERE x.adopted_from = e.id AND x.csv_file_id IS NULL`,
				);
			}
			// What a person approved in Import is what the original file says: it is saved with the
			// document (Ledger's extracted data), unless the document has transactions read out already.
			for (const e of rows.filter((r) => r.status === "approved" && r.document_id != null && Array.isArray(r.transactions) && r.transactions.length > 0).slice(0, 500)) {
				const have = (await files.extractedOf(e.document_id))?.data;
				if (Array.isArray(have?.transactions) && have.transactions.length > 0) continue;
				if (await files.saveExtracted(e.document_id, { data: rowsData(e.transactions, { currency: e.currency, approvedBy: e.decided_by ?? "" }) }, user)) result.extractions_saved++;
			}
		}

		if (t.mail_seen) {
			const mcols = await columnsOf("mail_seen");
			const { rowCount } = await q(
				`INSERT INTO ${T("mail_seen")} (folder, uidvalidity, uid, outcome, files, subject, mail_from, reason, mail_date, seen_at)
				 SELECT s.folder, s.uidvalidity, s.uid::text, s.outcome, s.files, s.subject, s.mail_from, ${mcols.has("reason") ? "s.reason" : "''"}, ${mcols.has("mail_date") ? "s.mail_date" : "NULL::timestamptz"}, s.seen_at
				   FROM ${SRC}.mail_seen s
				 ON CONFLICT (folder, uidvalidity, uid) DO NOTHING`,
			);
			result.mail_seen = rowCount;
		}
		if (t.mail_training) {
			const { rowCount } = await q(
				`INSERT INTO ${T("mail_training")} (label, features, sender, subject, file_name, source, created_by, created_at, adopted_from)
				 SELECT s.label, s.features, s.sender, s.subject, s.file_name, s.source, s.created_by, s.created_at, s.id
				   FROM ${SRC}.mail_training s
				  WHERE NOT EXISTS (SELECT 1 FROM ${T("adopted_ids")} a WHERE a.kind = 'training' AND a.source_id = s.id)
				  ORDER BY s.id`,
			);
			result.mail_training = rowCount;
			await remember("training", "mail_training");
		}
		// The email check's last run, unless this module's own check has run already.
		const stateTable = t.email_check_state ? "email_check_state" : t.state ? "state" : null;
		if (stateTable) {
			await q(`INSERT INTO ${T("module_state")} (key, value) SELECT 'mail', s.value FROM ${SRC}.${stateTable} s WHERE s.key = 'mail' ON CONFLICT (key) DO NOTHING`);
		}

		// Import's settings, the first time only (later changes made here are never overwritten).
		const before = await getState();
		if (before.settings_copied !== true) {
			const values = await importSettings();
			if (["gmail", "imap"].includes(values.mail_source)) values.mail_source = "mail"; // choices from before Ledger had one mailbox
			for (const [k, v] of Object.entries(values)) {
				try {
					await ctx.settings.set({ [k]: v });
					result.settings.push(k);
				} catch (err) {
					ctx.log.warn("a setting of the Import module was not copied", { key: k, err: String(err?.message || err) });
				}
			}
		}

		const total = (k) => n(before[k]) + result[k];
		await saveState({
			adopted_at: new Date().toISOString(),
			first_adopted_at: before.first_adopted_at ?? new Date().toISOString(),
			adopted_by: user.username,
			settings_copied: true,
			dismissed: false,
			files: total("files"),
			extractions: total("extractions"),
			mail_seen: total("mail_seen"),
			mail_training: total("mail_training"),
			settings: before.settings_copied === true ? (before.settings ?? []) : result.settings,
			waiting: result.waiting,
			runs: n(before.runs) + 1,
		});
		ctx.log.info("the Import module's data was taken over", { ...result, settings: result.settings.join(","), by: user.username });
		await syncTodo();
		for (const fn of listeners) await Promise.resolve(fn(result)).catch(() => {});
		return result;
	}

	const adminOnly = (req) => {
		if (req.user.role !== "admin") throw new ctx.HttpError(403, "only an admin can take over the Import module's data");
	};

	// GET /adoption: what of the Import module's data waits to be taken over, for the page's banner.
	ctx.route("GET", "/adoption", async (req) => ({ ...(await status()), admin: req.user.role === "admin" }));

	// POST /adoption {confirm: true} (admins): take over the Import module's data now. Safe to run again.
	ctx.route("POST", "/adoption", async (req) => {
		adminOnly(req);
		if (req.body?.confirm !== true) throw bad('confirm must be true: this takes over the Import module\'s inbox, email log and settings in this organization');
		const result = await adopt(req.user);
		return { adopted: result, status: { ...(await status()), admin: true } };
	});

	// POST /adoption/dismiss {dismissed: boolean} (admins): don't take Import's data over (the banner and
	// the to-do go, and the email check no longer waits for it), or offer it again.
	ctx.route("POST", "/adoption/dismiss", async (req) => {
		adminOnly(req);
		if (typeof req.body?.dismissed !== "boolean") throw bad("dismissed must be true or false");
		await saveState({ dismissed: req.body.dismissed, dismissed_by: req.user.username });
		await syncTodo();
		return { ...(await status()), admin: true };
	});

	// At startup, in every organization: say on the dashboard when Import's data waits. Not awaited.
	ctx.orgs.forEach(() => syncTodo()).catch((err) => ctx.log.warn("hand-over check failed", { err: String(err?.message || err) }));

	return { status, mailHold, adopt, onAdopted: (fn) => listeners.push(fn) };
}

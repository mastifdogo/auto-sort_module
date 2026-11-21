// The inbox (what the Import module, id "downloads", was until 0.17.0): files from the browser (the
// Send to Ledger extension in ui/extension/), from email (lib/mail.mjs), from a network scanner
// (lib/scanner-routes.mjs), from a phone's camera or the Android app (android/), or uploaded on the
// page wait here until a person makes them a statement, a bill or a receipt (directly, in this
// module), files them in Ledger's Documents as what they are, hands them to another module
// (ctx.files), or has the AI read their transactions (Extract data; a person approves what it read).
//
// No file is kept by the module: each one is one of Ledger's Documents (ctx.documents, any type
// since Ledger 0.27.0) and inbox_files keeps its id.
//
// Upload (the page, the extension and the phone app do this, with the user's login):
//   POST /inbox {name, content_type, size, source_url?, origin?, note?, account_code?, device?}  -> {id, chunk_size}
//   PUT  /inbox/:id/chunks/:index {data: base64}         (each chunk <= chunk_size bytes)
//   POST /inbox/:id/complete                              -> the file
// Chunks keep each request under Ledger's 1 MiB JSON limit; they wait in temporary files
// (lib/uploads.mjs) until the last one is in, then the file is filed in Documents.

import { createHash } from "node:crypto";
import { CHUNK_SIZE, chunkStore } from "./uploads.mjs";
import { DOCUMENT_KIND, notFound404 } from "./files.mjs";
import { pickable } from "./categorize.mjs";
import { rowsData, rowsFromData } from "./extraction.mjs";
import { readTrainingFile, TRAINING_FORMAT } from "./learn.mjs";
import { registerMail } from "./mail.mjs";
import {
	EXTRACT_MAX_BYTES, EXTRACT_MAX_CHARS, EXTRACT_SCHEMA, EXTRACT_SYSTEM, IMAGE_MAX_BYTES, IMAGE_MAX_COUNT,
	checkRows, cleanTransactions, extractKind, imageType, pdfJpegs, readableText,
} from "./extract-data.mjs";

const STALE_UPLOAD_HOURS = 24;
const NAME_RE = /^[^\u0000-\u001f/\\]{1,255}$/;
const FILE_COLUMNS = `id, name, content_type, size_bytes, sha256, status, source_url, note, received_by, received_at,
	sent_to, sent_link, sent_by, sent_at, sent_file_id, statement_id, bill_id, origin, origin_detail, account_code, (mail_features IS NOT NULL) AS learnable,
	mail_folder, mail_uid, document_id, document_added_here, adopted_from, updated_at`;
const CLIENT_ORIGINS = ["", "camera", "upload", "app"]; // what the page, the extension and the phone app may say; email and scanner are set here
// The phone app (android/ in this repository), published with each release of the module.
const APP_REPO = "mastifdogo/auto-sort_module";
const APP_APK = "ledger-import.apk";
const FILE_KINDS = ["statement", "bill", "receipt", "transaction", "customer", "vendor", "entity"]; // what ctx.files carries
const ACCOUNT_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const DATE_ORDERS = ["auto", "mdy", "dmy"];
/** Files the statement parsers read (lib/parse.mjs): CSV, OFX, QFX, QBO and plain text exports. */
const PARSABLE_RE = /\.(csv|tsv|txt|ofx|qfx|qbo)$/i;
const PARSABLE_TYPE_RE = /^(text\/(csv|plain|tab-separated-values)|application\/(x-ofx|vnd\.intu\.qfx|x-qfx|vnd\.intu\.qbo))\b/i;

/**
 * h: { q, T, bad, ai(), files, dtags, bills, stageStatement(parsed, opts), readStatement(file),
 * statementAccount(code), mailHold() }. Returns { saveFile, options, syncNotice } for the scanner.
 */
export function registerInbox(ctx, h) {
	const { q, T, bad, files } = h;
	/** Whether the admin asking has Ledger's root mode on. */
	const inRoot = (req) => req?.user?.root === true && typeof ctx.root?.remove === "function";
	const notFound = () => new ctx.HttpError(404, "no such file");
	const chunks = chunkStore(ctx.id);
	const orgId = async () => (await ctx.orgs.current()).id;

	async function options() {
		const v = await ctx.settings.get();
		const n = (x, d, lo, hi) => (typeof x === "number" && Number.isFinite(x) ? Math.min(Math.max(Math.round(x), lo), hi) : d);
		return { maxBytes: n(v.max_file_mb, 25, 1, 100) * 1024 * 1024, keepDays: n(v.keep_days, 0, 0, 3650) };
	}

	/** A file's row with the address the browser opens it at (its document in Ledger). */
	const withUrl = (r) => ({ ...r, url: r.document_id != null ? ctx.documents.url(r.document_id) : null });

	async function getFile(id) {
		if (!/^\d+$/.test(String(id))) throw notFound();
		const { rows } = await q(`SELECT ${FILE_COLUMNS} FROM ${T("inbox_files")} WHERE id = $1`, [id]);
		if (!rows[0]) throw notFound();
		return withUrl(rows[0]);
	}
	/** A file that has arrived (409 while it is still uploading). */
	async function getReadyFile(id) {
		const f = await getFile(id);
		if (f.status === "uploading") throw new ctx.HttpError(409, "this file hasn't finished uploading");
		return f;
	}

	/** A bill's reading kept as JSON while a person compares it (amounts are BigInt). */
	const stash = (x) => JSON.stringify(x, (k, v) => (typeof v === "bigint" ? { $cents: v.toString() } : v));
	function unstash(v) {
		if (v == null) return null;
		const revive = (x) =>
			Array.isArray(x) ? x.map(revive)
			: x && typeof x === "object" ? (typeof x.$cents === "string" && /^-?\d+$/.test(x.$cents) ? BigInt(x.$cents) : Object.fromEntries(Object.entries(x).map(([k, y]) => [k, revive(y)])))
			: x;
		return revive(typeof v === "string" ? JSON.parse(v) : v);
	}

	// ---------------------------------------------------------------------
	// Where file bytes live: in Ledger's Documents, always. A file the store already has is used
	// as it is, never added twice (document_added_here says which it was).
	// ---------------------------------------------------------------------

	async function place(name, data, { kind = "other", note = "", type = "", user } = {}) {
		const d = await files.fileDocument({ kind, filename: name, data, content_type: /^[\w.+-]+\/[\w.+-]+$/.test(String(type).split(";")[0].trim()) ? String(type).split(";")[0].trim() : undefined, note: note.slice(0, 2000) }, user);
		return { document_id: d.id, document_added_here: d.added };
	}

	/**
	 * What a deleted inbox file leaves behind: nothing. Its document in Ledger's Documents goes with
	 * it, whoever filed it (this module, or Import before the hand-over), unless it was sent on or
	 * filed (then it is one of the organization's documents) or something else here (another inbox
	 * entry, a bill, a statement) uses it. Ledger lets a module delete only documents it added
	 * itself; for any other, the document's id is returned and the page deletes it as the person
	 * who asked (opts.byPerson), who may.
	 */
	async function discard(f, opts = {}) {
		if (f.document_id == null || f.sent_at) return null;
		if (!f.document_added_here && !opts.byPerson) return null;
		if ((await files.usesOf(f.document_id)) > 0) return null;
		try {
			await ctx.documents.remove(f.document_id);
		} catch (err) {
			if (err?.status === 403 && opts.byPerson) return Number(f.document_id);
			if (err?.status !== 404 && err?.status !== 403) ctx.log.warn("document not removed", { document: String(f.document_id), err: String(err?.message || err) });
		}
		return null;
	}

	const MISSING = "this file is missing from Ledger's Documents (removed there, or after a restore from a dump file, which brings back only the tables); delete it from the inbox";
	async function fileBytes(f) {
		if (f.document_id == null) throw new ctx.HttpError(410, MISSING);
		try {
			return await ctx.documents.read(f.document_id);
		} catch (err) {
			if (notFound404(err)) throw new ctx.HttpError(410, MISSING);
			throw err;
		}
	}

	/**
	 * Stores a whole file (from email, the scanner) in the inbox → its id. skipKnown: a file that is
	 * already a document this module uses (a bill's, a statement's, another inbox file's) isn't
	 * added again → null.
	 */
	async function saveFile(name, type, data, { origin = "", detail = "", note = "", source_url = "", by, user, features = null, kind = "other", mail = null, skipKnown = false }) {
		const p = await place(name, data, { kind, note, type, user });
		if (skipKnown && !p.document_added_here && (await files.usesOf(p.document_id)) > 0) return null;
		let rows;
		try {
			({ rows } = await q(
				`INSERT INTO ${T("inbox_files")} (name, content_type, size_bytes, sha256, status, source_url, note, received_by, origin, origin_detail, mail_features, document_id, document_added_here, mail_folder, mail_uid)
				 VALUES ($1, $2, $3, $4, 'new', $5, $6, $7, $8, $9, $10::text[], $11, $12, $13, $14) RETURNING id`,
				[name.slice(0, 255), String(type).slice(0, 200), data.length, createHash("sha256").update(data).digest("hex"), source_url, note.slice(0, 1000), by, origin, detail.slice(0, 200), features, String(p.document_id), p.document_added_here, String(mail?.folder ?? "").slice(0, 300), String(mail?.uid ?? "").slice(0, 300)],
			));
		} catch (err) {
			if (p.document_added_here) await files.removeDocumentIfUnused(p.document_id);
			throw err;
		}
		ctx.log.info("file received", { file: String(rows[0].id), name, bytes: data.length, origin, by, document: String(p.document_id) });
		return rows[0].id;
	}

	/** Email files someone wanted (sent them on, or imported a skipped email): wanted examples, once each. */
	async function learnKept(ids, source, by) {
		const list = (Array.isArray(ids) ? ids : [ids]).filter((x) => x != null).map(String);
		if (list.length === 0) return;
		await q(
			`WITH f AS (
				UPDATE ${T("inbox_files")} SET mail_trained = true WHERE id = ANY($1::bigint[]) AND mail_features IS NOT NULL AND NOT mail_trained
				RETURNING mail_features, origin_detail, note, name
			)
			INSERT INTO ${T("mail_training")} (label, features, sender, subject, file_name, source, created_by)
			SELECT 1, mail_features, origin_detail, note, name, $2, $3 FROM f`,
			[list, source, by],
		);
	}

	/** Marks a file sent: what it became and where to see it. */
	async function markSent(f, { to, link = "", by, sentFileId = null, statementId = null, billId = null }) {
		await q(
			`UPDATE ${T("inbox_files")} SET status = 'sent', sent_to = $2, sent_link = $3, sent_by = $4, sent_at = now(), sent_file_id = $5,
			        statement_id = COALESCE($6, statement_id), bill_id = COALESCE($7, bill_id), updated_at = now() WHERE id = $1`,
			[f.id, String(to).slice(0, 200), link, by, sentFileId, statementId, billId],
		);
		await learnKept(f.id, "sent", by);
	}

	// ---------------------------------------------------------------------
	// Dashboard: one notification while files wait in the inbox
	// ---------------------------------------------------------------------

	async function syncNotice() {
		try {
			const { rows } = await q(`SELECT name FROM ${T("inbox_files")} WHERE status = 'new' ORDER BY received_at DESC`);
			const n = rows.length;
			if (n === 0) await ctx.dashboard.remove("inbox", "notification");
			else await ctx.dashboard.notify({
				key: "inbox",
				title: `${n} file${n === 1 ? "" : "s"} waiting in ${ctx.name}'s inbox`,
				body: rows.slice(0, 3).map((r) => r.name).join(", ") + (n > 3 ? ", …" : ""),
				level: "info",
				link: `/apps/${ctx.id}?tab=inbox`,
			});
			await syncReviewTodo();
		} catch (err) {
			ctx.log.warn("dashboard update failed", { err: String(err?.message || err) });
		}
	}

	// A to-do while what the AI read from a file waits for a person to check it.
	async function syncReviewTodo() {
		const { rows } = await q(`SELECT f.name FROM ${T("inbox_extractions")} e JOIN ${T("inbox_files")} f ON f.id = e.file_id WHERE e.status = 'pending' ORDER BY e.id`);
		if (rows.length === 0) return void (await ctx.dashboard.remove("inbox-review"));
		const n = rows.length;
		await ctx.dashboard.todo({
			key: "inbox-review",
			title: `Check what the AI read from ${n} file${n === 1 ? "" : "s"} in ${ctx.name}'s inbox`,
			body: rows.slice(0, 3).map((r) => r.name).join(", ") + (n > 3 ? ", …" : ""),
			link: `/apps/${ctx.id}?tab=inbox`,
		});
	}

	// ---------------------------------------------------------------------
	// Upload
	// ---------------------------------------------------------------------

	ctx.route("POST", "/inbox", async (req) => {
		const b = req.body ?? {};
		const name = typeof b.name === "string" ? b.name.trim() : "";
		if (!NAME_RE.test(name)) throw bad("name must be a file name of 1-255 characters");
		const size = Number(b.size);
		const { maxBytes } = await options();
		if (!Number.isSafeInteger(size) || size < 1) throw bad("size must be the file's size in bytes");
		if (size > maxBytes) throw new ctx.HttpError(413, `the file is larger than ${maxBytes / 1024 / 1024} MB (the limit is under Settings → ${ctx.name})`);
		if (b.content_type !== undefined && typeof b.content_type !== "string") throw bad("content_type must be a media type such as application/pdf");
		const type = typeof b.content_type === "string" ? b.content_type.slice(0, 200) : "";
		if (b.source_url !== undefined && typeof b.source_url !== "string") throw bad("source_url must be the address the file came from");
		let source = typeof b.source_url === "string" ? b.source_url.trim() : "";
		if (source && !(/^https?:\/\/\S{1,2000}$/.test(source) && URL.canParse(source))) source = ""; // the page shows its host
		const origin = b.origin === undefined ? "" : b.origin;
		if (!CLIENT_ORIGINS.includes(origin)) throw bad('origin must be "camera", "upload" or "app" (or left out)');
		// The phone app sends the note and the account chosen on the phone with the file.
		const note = b.note === undefined ? "" : b.note;
		if (typeof note !== "string" || note.length > 1000) throw bad("note must be text of at most 1000 characters");
		const account = b.account_code === undefined ? "" : b.account_code;
		if (typeof account !== "string" || !(account === "" || ACCOUNT_CODE_RE.test(account))) throw bad("account_code must be an account's code");
		const detail = origin === "app" && typeof b.device === "string" ? b.device.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200) : "";
		const { rows } = await q(
			`INSERT INTO ${T("inbox_files")} (name, content_type, size_bytes, source_url, received_by, origin, note, account_code, origin_detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
			[name, type, size, source, req.user.username, origin, note, account, detail],
		);
		return ctx.response(201, { id: rows[0].id, chunk_size: CHUNK_SIZE, chunks: Math.ceil(size / CHUNK_SIZE) });
	});

	ctx.route("PUT", "/inbox/:id/chunks/:index", async (req) => {
		const f = await getFile(req.params.id);
		if (f.status !== "uploading") throw new ctx.HttpError(409, "this file is already complete");
		if (!/^\d{1,6}$/.test(req.params.index)) throw bad("index must be a number");
		const index = Number(req.params.index);
		const count = Math.ceil(Number(f.size_bytes) / CHUNK_SIZE);
		if (index >= count) throw bad(`index must be below ${count}`);
		const b64 = req.body?.data;
		if (typeof b64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw bad("data must be base64");
		const data = Buffer.from(b64, "base64");
		const expected = index === count - 1 ? Number(f.size_bytes) - index * CHUNK_SIZE : CHUNK_SIZE;
		if (data.length !== expected) throw bad(`chunk ${index} must be ${expected} bytes, got ${data.length}`);
		// The piece waits in a temporary file until the upload is complete; never in the database.
		await chunks.put(await orgId(), f.id, index, data);
	});

	ctx.route("POST", "/inbox/:id/complete", async (req) => {
		const f = await getFile(req.params.id);
		if (f.status !== "uploading") return f;
		const org = await orgId();
		const whole = await chunks.assemble(org, f.id, Number(f.size_bytes));
		if (whole.missing) throw new ctx.HttpError(409, `chunks missing: ${whole.missing.slice(0, 10).join(", ")}`);
		if (whole.error) throw bad(whole.error);
		const sha = createHash("sha256").update(whole.data).digest("hex");
		const { rows: dup } = await q(`SELECT id, name, status FROM ${T("inbox_files")} WHERE sha256 = $1 AND id <> $2 ORDER BY id DESC LIMIT 1`, [sha, f.id]);
		// The file is filed in Ledger's Documents (a receipt when it comes from a camera); the inbox keeps its id.
		const p = await place(f.name, whole.data, { kind: f.origin === "camera" || f.origin === "app" ? "receipt" : "other", note: f.note || "", type: f.content_type, user: req.user });
		const { rowCount } = await q(
			`UPDATE ${T("inbox_files")} SET status = 'new', sha256 = $2, document_id = $3, document_added_here = $4, updated_at = now() WHERE id = $1 AND status = 'uploading'`,
			[f.id, sha, String(p.document_id), p.document_added_here],
		);
		await chunks.discard(org, f.id);
		if (rowCount > 0) ctx.log.info("file received", { file: String(f.id), name: f.name, bytes: Number(f.size_bytes), by: req.user.username, document: String(p.document_id) });
		await syncNotice();
		return { ...(await getFile(f.id)), duplicate_of: dup[0] ?? null };
	});

	// ---------------------------------------------------------------------
	// Inbox
	// ---------------------------------------------------------------------

	ctx.route("GET", "/inbox", async (req) => {
		const status = req.query.get("status") || "new";
		if (!["new", "sent", "archived", "all"].includes(status)) throw bad("status must be new, sent, archived or all");
		const { rows } = await q(
			`SELECT ${FILE_COLUMNS} FROM ${T("inbox_files")} WHERE status <> 'uploading' AND ($1 = 'all' OR status = $1) ORDER BY received_at DESC LIMIT 500`,
			[status],
		);
		const { rows: counts } = await q(`SELECT status, count(*)::int AS n FROM ${T("inbox_files")} WHERE status <> 'uploading' GROUP BY status`);
		// What the AI read, waiting for review.
		const { rows: pend } = await q(`SELECT file_id, max(id) AS id FROM ${T("inbox_extractions")} WHERE status = 'pending' GROUP BY file_id`);
		const pending = new Map(pend.map((p) => [String(p.file_id), p.id]));
		for (const r of rows) if (pending.has(String(r.id))) r.pending_extraction = pending.get(String(r.id));
		// Files handed to another module: what that module made of them (ctx.files outbox).
		if (rows.some((r) => r.sent_file_id != null)) {
			const out = new Map((await ctx.files.outbox({ limit: 500 })).map((o) => [String(o.id), o]));
			for (const r of rows) {
				const o = r.sent_file_id != null ? out.get(String(r.sent_file_id)) : null;
				if (o) r.handoff = { status: o.status, result: o.result };
			}
		}
		// The documents say what they're filed as, carry Ledger's tags, and whether their data was read
		// out. After a restore from a dump file (tables only), or when someone removed it on the
		// Documents page, a row can point at a file that isn't there.
		const data = rows.map(withUrl);
		await Promise.all(data.map(async (r) => {
			const d = r.document_id == null ? null : await ctx.documents.get(r.document_id).catch(() => null);
			if (!d) return void Object.assign(r, { missing: true, url: null });
			// Read fresh each time: account codes can be renamed, and a statement reconciled.
			r.document = {
				kind: d.kind, account_code: d.account_code ?? null, account_name: d.account_name ?? null, reconciled: d.reconciled === true,
				tags: (d.tags ?? []).map((t) => ({ tag: t.tag, note: t.note })),
				extracted: d.extracted ? { keys: d.extracted.keys ?? [], url: d.extracted.url ?? null, module_id: d.extracted.module_id ?? null } : null,
			};
		}));
		return { data, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
	});

	ctx.route("GET", "/inbox/:id", async (req) => getFile(req.params.id));

	// POST /inbox/:id/sent {to, link?}: the page sent the file somewhere itself (Ledger's CSV files).
	ctx.route("POST", "/inbox/:id/sent", async (req) => {
		const f = await getReadyFile(req.params.id);
		const to = typeof req.body?.to === "string" ? req.body.to.trim().slice(0, 200) : "";
		if (!to) throw bad("to is required (where the file was sent)");
		const link = typeof req.body?.link === "string" ? req.body.link.trim() : "";
		if (link && !/^\/(?![/\\])\S{0,500}$/.test(link)) throw bad("link must be a path inside Ledger");
		await markSent(f, { to, link, by: req.user.username });
		await syncNotice();
		return getFile(f.id);
	});

	// ---------------------------------------------------------------------
	// What a file becomes, in this module: a statement (its lines staged for review) or a bill or
	// receipt (read, then reviewed). No hand-off to itself: the document stays where it is.
	// ---------------------------------------------------------------------

	const parsable = (f) => PARSABLE_RE.test(f.name) || PARSABLE_TYPE_RE.test(f.content_type || "");

	// POST /inbox/:id/statement {account_code, flip_signs?, date_order?}: stage the file's transactions as
	// a statement of that account. A CSV, OFX or QFX file is parsed; any other file needs its data
	// read out first (Extract data, approved by a person). Read once: what Ledger keeps of the
	// document is used instead of parsing it again.
	ctx.route("POST", "/inbox/:id/statement", async (req) => {
		const f = await getReadyFile(req.params.id);
		const b = req.body ?? {};
		if (typeof b.account_code !== "string" || b.account_code === "") throw bad("account_code (the bank or card account) is required");
		if (b.flip_signs !== undefined && typeof b.flip_signs !== "boolean") throw bad("flip_signs must be true or false");
		if (b.date_order !== undefined && !DATE_ORDERS.includes(b.date_order)) throw bad("date_order must be auto, mdy or dmy");
		const { account } = await h.statementAccount(b.account_code);
		if (!account.is_active) throw bad(`account ${account.code} is inactive`);
		if (!pickable(account) || !["asset", "liability"].includes(account.type)) throw bad(`choose an active bank (asset) or card (liability) account; ${account.code} isn't one`);
		if (f.document_id == null) throw new ctx.HttpError(410, MISSING);
		const parsed = await h.readStatement({
			documentId: f.document_id,
			filename: f.name,
			dateOrder: b.date_order ?? "auto",
			text: parsable(f) ? async () => (await fileBytes(f)).toString("utf8") : null,
		});
		if (!parsed) throw new ctx.HttpError(409, "this file's transactions haven't been read yet: choose Extract data first and check what the AI read (CSV, OFX and QFX files are read without it)");
		if (b.check_similar !== undefined && typeof b.check_similar !== "boolean") throw bad("check_similar must be true or false");
		// The inbox page asks first: transactions already here (uploaded before, or the same date and
		// amount on this account) are shown for the person to confirm. Nothing is staged yet.
		if (b.check_similar === true) {
			const similar = await h.similarStatementRows(parsed, account, b.flip_signs === true);
			if (similar.count > 0) return { ...(await getFile(f.id)), similar: { kind: "statement", ...similar } };
		}
		const fromEmail = f.origin === "email";
		const r = await h.stageStatement(parsed, {
			filename: f.name,
			account,
			flip: b.flip_signs === true,
			uploadedBy: req.user.username,
			user: req.user,
			source: fromEmail ? "email" : "upload",
			mail: fromEmail ? { messageId: null, from: f.origin_detail, subject: f.note, sourceKey: null } : null,
			document: { documentId: Number(f.document_id), type: f.content_type || "text/csv", size: Number(f.size_bytes) },
		});
		if (r.transactions === 0) throw new ctx.HttpError(409, `all ${r.duplicates} transactions in this file were uploaded before`);
		await markSent(f, { to: `Statement #${r.id} (${r.transactions} transaction${r.transactions === 1 ? "" : "s"})`, link: `/apps/${ctx.id}?statement=${r.id}`, by: req.user.username, statementId: r.id });
		await syncNotice();
		return { ...(await getFile(f.id)), statement: { id: r.id, transactions: r.transactions, duplicates: r.duplicates, from_extraction: r.from_extraction, warnings: parsed.warnings.slice(0, 50) } };
	});

	// POST /inbox/:id/bill {kind?: "bill" | "receipt"}: the file is a bill or a receipt (a PDF, a picture
	// or a saved email). What was already read out of it is used; else the AI reads it. Either way
	// it lands on the Bills or Receipts tab as Needs review: a person approves it.
	ctx.route("POST", "/inbox/:id/bill", async (req) => {
		const f = await getReadyFile(req.params.id);
		const kind = req.body?.kind;
		if (kind !== undefined && !["bill", "receipt"].includes(kind)) throw bad('kind must be "bill" or "receipt"');
		const checkSimilar = req.body?.check_similar;
		const confirm = req.body?.confirm;
		if (checkSimilar !== undefined && typeof checkSimilar !== "boolean") throw bad("check_similar must be true or false");
		if (confirm !== undefined && typeof confirm !== "boolean") throw bad("confirm must be true or false");
		const data = await fileBytes(f);
		const fromEmail = f.origin === "email";
		const subject = /^Email from .*?: "(.*)"$/s.exec(f.note || "")?.[1] ?? "";
		// Confirmed after comparing: what was read then is used (the AI isn't asked again).
		const reading = confirm === true ? unstash((await q(`SELECT pending_bill FROM ${T("inbox_files")} WHERE id = $1`, [f.id])).rows[0]?.pending_bill) : null;
		const r = await h.bills.ingestDocument({
			filename: f.name,
			data,
			source: fromEmail ? "email" : "upload",
			kind: kind ?? null,
			from: fromEmail ? f.origin_detail : "",
			note: fromEmail ? "" : f.note || "",
			mail: fromEmail ? { from: f.origin_detail, subject: subject || f.name } : null,
			documentId: Number(f.document_id),
			user: req.user,
			checkSimilar: checkSimilar === true && confirm !== true,
			allowDuplicate: confirm === true,
			reading,
		});
		if (r.outcome === "similar") {
			// Bills or receipts like it are here: kept for the person to compare; nothing is added yet.
			await q(`UPDATE ${T("inbox_files")} SET pending_bill = $2, updated_at = now() WHERE id = $1`, [f.id, stash(r.reading)]);
			const view = (x) => ({ kind: x.kind ?? kind ?? "bill", vendor: x.vendor ?? "", invoice_number: x.invoice_number ?? "", bill_date: x.bill_date ?? null, due_date: x.due_date ?? null, amount_cents: x.amount_cents == null ? null : String(x.amount_cents), currency: x.currency ?? "" });
			return {
				...(await getFile(f.id)),
				similar: {
					kind: "bill",
					reading: view(r.reading),
					matches: r.similar.map((m) => ({ score: m.score, same: m.same, bill: { id: m.bill.id, status: m.bill.status, account_code: m.bill.account_code ?? null, ...view(m.bill) } })),
				},
			};
		}
		if (r.outcome === "duplicate") throw new ctx.HttpError(409, `this looks like bill #${r.bill_id}, which is already here`);
		await q(`UPDATE ${T("inbox_files")} SET pending_bill = NULL WHERE id = $1 AND pending_bill IS NOT NULL`, [f.id]);
		// The account a person chose on the phone for a receipt is that person's choice, not the AI's.
		if (f.account_code) {
			const a = (await ctx.ledger.listAccounts()).find((x) => x.code === f.account_code);
			if (a && pickable(a)) await q(`UPDATE ${T("bills")} SET account_code = $2, currency = $3 WHERE id = $1 AND status = 'new'`, [r.bill_id, a.code, a.currency]);
		}
		const bill = await h.bills.getBill(String(r.bill_id));
		const what = bill.kind === "receipt" ? "Receipt" : "Bill";
		await markSent(f, { to: `${what} #${bill.id}${bill.vendor ? ` (${bill.vendor})` : ""}`, link: `/apps/${ctx.id}?bill=${bill.id}`, by: req.user.username, billId: bill.id });
		await h.bills.autoMatch();
		await syncNotice();
		return { ...(await getFile(f.id)), bill: { id: bill.id, kind: bill.kind, vendor: bill.vendor, amount_cents: bill.amount_cents, currency: bill.currency, read: r.read } };
	});

	// POST /inbox/:id/same-as {bill_id} | {statement_id}: the person compared and it is one already
	// here. Nothing is added; the file is marked sent to that bill, receipt or statement.
	ctx.route("POST", "/inbox/:id/same-as", async (req) => {
		const f = await getReadyFile(req.params.id);
		const b = req.body ?? {};
		const idOk = (v) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0) || (typeof v === "string" && /^\d+$/.test(v));
		if (b.bill_id !== undefined) {
			if (!idOk(b.bill_id)) throw bad("bill_id must be a bill id");
			const bill = await h.bills.getBill(String(b.bill_id));
			const what = bill.kind === "receipt" ? "Receipt" : "Bill";
			await q(`UPDATE ${T("inbox_files")} SET pending_bill = NULL WHERE id = $1`, [f.id]);
			await markSent(f, { to: `Same as ${what} #${bill.id}${bill.vendor ? ` (${bill.vendor})` : ""}`.slice(0, 200), link: `/apps/${ctx.id}?bill=${bill.id}`, by: req.user.username, billId: bill.id });
		} else if (b.statement_id !== undefined) {
			if (!idOk(b.statement_id)) throw bad("statement_id must be a statement id");
			const { rows } = await q(`SELECT id, filename FROM ${T("statements")} WHERE id = $1`, [String(b.statement_id)]);
			if (rows.length === 0) throw new ctx.HttpError(404, "no such statement");
			await markSent(f, { to: `Same as statement #${rows[0].id} (${rows[0].filename})`.slice(0, 200), link: `/apps/${ctx.id}?statement=${rows[0].id}`, by: req.user.username, statementId: rows[0].id });
		} else throw bad("bill_id or statement_id is required");
		await syncNotice();
		return getFile(f.id);
	});

	// ---------------------------------------------------------------------
	// Ledger's Documents, and other modules (ctx.files)
	// ---------------------------------------------------------------------

	// POST /inbox/:id/file-as {kind: "receipt"|"statement"|"invoice"|"other", account_code?}: say what the
	// file is in Ledger's Documents (where other modules and Reconcile pick it up); it is then marked sent.
	ctx.route("POST", "/inbox/:id/file-as", async (req) => {
		const f = await getReadyFile(req.params.id);
		const b = req.body ?? {};
		if (!["receipt", "statement", "invoice", "other"].includes(b.kind)) throw bad("kind must be receipt, statement, invoice or other");
		if (b.account_code !== undefined && b.account_code !== "" && (typeof b.account_code !== "string" || !ACCOUNT_CODE_RE.test(b.account_code))) throw bad("account_code must be an account code");
		if (f.document_id == null) throw new ctx.HttpError(410, MISSING);
		const change = { kind: b.kind };
		if (b.kind === "statement" && b.account_code) change.account_code = b.account_code;
		try {
			await ctx.documents.update(f.document_id, change);
		} catch (err) {
			if (notFound404(err)) throw new ctx.HttpError(410, MISSING);
			throw err; // e.g. 422: no such account
		}
		// No account code in this note: codes can be renamed; the page shows the document's current account.
		await markSent(f, { to: `Documents (${b.kind})`, link: "/documents", by: req.user.username });
		await syncNotice();
		return getFile(f.id);
	});

	// GET /targets: other running modules that take files, and which kinds.
	ctx.route("GET", "/targets", async () => ({ data: ctx.files.targets().filter((t) => t.id !== ctx.id) }));

	// POST /inbox/:id/handoff {to, kind, account_code?, note?}: hand the file to that module as the document
	// it is (no copy is made); it is then marked sent.
	ctx.route("POST", "/inbox/:id/handoff", async (req) => {
		const f = await getReadyFile(req.params.id);
		const b = req.body ?? {};
		const to = typeof b.to === "string" ? b.to : "";
		if (!/^[a-z][a-z0-9-]{1,31}$/.test(to) || to === ctx.id) throw bad("to must be the id of another module");
		if (!FILE_KINDS.includes(b.kind)) throw bad(`kind must be one of ${FILE_KINDS.join(", ")}`);
		const target = ctx.files.targets(b.kind).find((t) => t.id === to);
		if (!target) throw new ctx.HttpError(409, `the module "${to}" isn't running or doesn't take ${b.kind} files`);
		const meta = {};
		if (b.account_code !== undefined && b.account_code !== "") {
			if (typeof b.account_code !== "string" || !ACCOUNT_CODE_RE.test(b.account_code)) throw bad("account_code must be an account code");
			meta.account_code = b.account_code;
		}
		if (f.source_url) meta.source_url = f.source_url;
		const note = b.note === undefined ? f.note : b.note;
		if (typeof note !== "string" || note.length > 2000) throw bad("note must be text of at most 2000 characters");
		if (f.document_id == null) throw new ctx.HttpError(410, MISSING);
		const sent = await ctx.files.send({ to, kind: b.kind, document_id: Number(f.document_id), filename: f.name, meta, note }, req.user);
		await markSent(f, { to: `${target.name} (${b.kind})`, link: `/apps/${to}`, by: req.user.username, sentFileId: sent.id });
		// Said in Documents too: what it is, and for a statement whose account.
		if (DOCUMENT_KIND[b.kind] && ["statement", "bill", "receipt"].includes(b.kind)) {
			await files.updateDocument(f.document_id, { kind: DOCUMENT_KIND[b.kind], ...(b.kind === "statement" && meta.account_code ? { account_code: meta.account_code } : {}) }, { onlyOwn: false });
		}
		ctx.log.info("file handed off", { file: String(f.id), to, kind: b.kind, module_file: String(sent.id), by: req.user.username });
		await syncNotice();
		return { ...(await getFile(f.id)), handoff: { status: sent.status, result: sent.result } };
	});

	ctx.route("PATCH", "/inbox/:id", async (req) => {
		const f = await getFile(req.params.id);
		const b = req.body ?? {};
		const sets = [];
		const params = [f.id];
		if (b.status !== undefined) {
			if (!["new", "archived"].includes(b.status)) throw bad('status must be "new" or "archived"');
			if (f.status === "uploading") throw new ctx.HttpError(409, "this file hasn't finished uploading");
			params.push(b.status);
			sets.push(`status = $${params.length}`);
		}
		if (b.note !== undefined) {
			if (typeof b.note !== "string" || b.note.length > 1000) throw bad("note must be text of at most 1000 characters");
			params.push(b.note);
			sets.push(`note = $${params.length}`);
		}
		if (b.name !== undefined) {
			const name = typeof b.name === "string" ? b.name.trim() : "";
			if (!NAME_RE.test(name)) throw bad("name must be a file name of 1-255 characters");
			params.push(name);
			sets.push(`name = $${params.length}`);
		}
		if (sets.length === 0) throw bad("nothing to change: give status, note or name");
		await q(`UPDATE ${T("inbox_files")} SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params);
		await syncNotice();
		return getFile(f.id);
	});

	// DELETE /inbox/:id[?learn=1]: with learn=1 an email file also teaches the email check to skip files like it.
	ctx.route("DELETE", "/inbox/:id", async (req) => {
		const f = await getFile(req.params.id);
		if (inRoot(req)) {
			// Root mode: through Ledger, so the deletion can be reversed. Rows that hang off the file go
			// first, one by one (cascaded rows aren't kept); the file's document stays, so a reversed
			// deletion brings the file back whole.
			const { rows: ex } = await q(`SELECT id FROM ${T("inbox_extractions")} WHERE file_id = $1 ORDER BY id`, [f.id]);
			for (const e of ex) await ctx.root.remove(req, "inbox_extractions", e.id, `${ctx.name}: deleted what the AI read from ${f.name}`);
			await ctx.root.remove(req, "inbox_files", f.id, `${ctx.name}: deleted ${f.name} from the inbox`);
			await syncNotice();
			return { deleted: true, learned: false, root: true };
		}
		const learn = req.query.get("learn") === "1";
		const { rows } = await q(
			`WITH gone AS (DELETE FROM ${T("inbox_files")} WHERE id = $1 RETURNING mail_features, origin_detail, note, name)
			INSERT INTO ${T("mail_training")} (label, features, sender, subject, file_name, source, created_by)
			SELECT -1, mail_features, origin_detail, note, name, 'delete', $2 FROM gone WHERE $3 AND mail_features IS NOT NULL
			RETURNING id`,
			[f.id, req.user.username, learn],
		);
		if (rows[0]) ctx.log.info("email check learned", { file: f.name, from: f.origin_detail, by: req.user.username });
		if (f.status === "uploading") await chunks.discard(await orgId(), f.id);
		const left = await discard(f, { byPerson: true });
		await syncNotice();
		// delete_document: a document Ledger wouldn't let the module remove (Import filed it); the page removes it.
		return { deleted: true, learned: !!rows[0], ...(left != null ? { delete_document: left } : {}) };
	});

	// ---------------------------------------------------------------------
	// Extract data: a file that isn't a CSV (a PDF, a photo, a text statement) is read by the AI
	// set under Settings → LLM API (ctx.llm). What it read waits as a suggestion; approved by a
	// person (corrected or not), it is saved with the document in Ledger (its extracted data), and
	// the file can then be staged as a statement straight from it.
	// ---------------------------------------------------------------------

	// GET /ai: whether extraction can be offered, for the page.
	ctx.route("GET", "/ai", async () => {
		const st = await ctx.llm.status();
		return { configured: !!st.configured, allowed: !!st.allowed, reads_pdf: !!st.readsPdf, reads_images: !!st.images?.configured };
	});

	// POST /inbox/:id/extract {instructions?, reread?} -> 201, a pending extraction for a person to check;
	// nothing else changes. A file whose transactions were read before isn't read again (409) unless reread.
	ctx.route("POST", "/inbox/:id/extract", async (req) => {
		const f = await getReadyFile(req.params.id);
		const extra = req.body?.instructions;
		if (extra !== undefined && (typeof extra !== "string" || extra.length > 1000)) throw bad("instructions must be text of at most 1000 characters");
		if (req.body?.reread !== undefined && typeof req.body.reread !== "boolean") throw bad("reread must be true or false");
		const kind = extractKind(f);
		if (kind === "csv") throw bad("this file is already a CSV; send it as it is");
		if (!kind) throw bad("there's no way to extract data from this kind of file: only PDFs, photos (JPEG, PNG, GIF, WebP) and text files (TXT, OFX, QFX, HTML, XML, JSON, TSV, EML) can be read");
		if (Number(f.size_bytes) > EXTRACT_MAX_BYTES) throw new ctx.HttpError(413, `the file is larger than ${EXTRACT_MAX_BYTES / 1024 / 1024} MB, too large to extract from`);
		// Read once: what Ledger keeps of this document already lists its transactions.
		const have = (await files.extractedOf(f.document_id))?.data;
		if (req.body?.reread !== true && Array.isArray(have?.transactions) && have.transactions.length > 0) {
			throw new ctx.HttpError(409, `this file's ${have.transactions.length} transactions were already read; use them as they are (Send → Statement), or ask to read it again`);
		}

		const st = await ctx.llm.status();
		const readsImages = !!st.images?.configured;
		if (!st.allowed) throw new ctx.HttpError(403, `${ctx.name} isn't allowed to use the LLM API; an admin can allow it under Settings → LLM API`);
		if (kind === "text" && !st.configured) throw new ctx.HttpError(409, "no LLM connection for text is set up; an admin can add one under Settings → LLM API");
		if (kind === "image" && !readsImages) throw new ctx.HttpError(409, "no LLM connection for images is set up; an admin can add one under Settings → LLM API");
		if (kind === "pdf" && !st.readsPdf && !readsImages) {
			throw new ctx.HttpError(409, "reading PDFs needs an LLM connection for images and documents under Settings → LLM API (one that reads PDFs reads any PDF; another vision model reads scanned ones)");
		}

		const bytes = await fileBytes(f);
		const ask = { system: EXTRACT_SYSTEM, schema: EXTRACT_SCHEMA, maxTokens: 16_000, prompt: "" };
		const note = typeof extra === "string" && extra.trim() ? `\n\nThe user adds: ${extra.trim()}` : "";
		if (kind === "pdf" && st.readsPdf) {
			ask.documents = [{ media_type: "application/pdf", data: bytes.toString("base64"), name: f.name }];
			ask.prompt = `Extract every transaction from the attached document "${f.name}".${note}`;
		} else if (kind === "pdf") {
			// The image model can't read PDFs: send the photos a scanned PDF is made of.
			const jpegs = pdfJpegs(bytes);
			if (jpegs.length === 0) throw bad("this PDF has no scanned pages the image model can read; reading other PDFs needs an LLM connection that reads PDFs (Settings → LLM API)");
			if (jpegs.length > IMAGE_MAX_COUNT) throw bad(`this PDF has more than ${IMAGE_MAX_COUNT} pages, too many to read at once`);
			if (jpegs.some((j) => j.length > IMAGE_MAX_BYTES)) throw new ctx.HttpError(413, `a page of this PDF is larger than ${IMAGE_MAX_BYTES / 1024 / 1024} MB`);
			ask.images = jpegs.map((j) => ({ media_type: "image/jpeg", data: j.toString("base64") }));
			ask.prompt = `Extract every transaction from the attached ${jpegs.length === 1 ? "picture" : `${jpegs.length} pictures (the pages, in order)`} of "${f.name}".${note}`;
		} else if (kind === "image") {
			const type = imageType(bytes);
			if (!type) throw bad("this file isn't a JPEG, PNG, GIF or WebP picture");
			if (bytes.length > IMAGE_MAX_BYTES) throw new ctx.HttpError(413, `the picture is larger than ${IMAGE_MAX_BYTES / 1024 / 1024} MB; use the Scan tab on a phone, which shrinks photos`);
			ask.images = [{ media_type: type, data: bytes.toString("base64") }];
			ask.prompt = `Extract every transaction from the attached picture "${f.name}".${note}`;
		} else {
			const text = readableText(bytes, f.name);
			if (text === null) throw bad("this file isn't readable text");
			if (!text.trim()) throw bad("this file is empty");
			if (text.length > EXTRACT_MAX_CHARS) throw new ctx.HttpError(413, `this file has more than ${EXTRACT_MAX_CHARS.toLocaleString("en")} characters of text, too much to extract in one go`);
			ask.prompt = `Extract every transaction from the file "${f.name}" below.${note}\n\n<file>\n${text}\n</file>`;
		}

		const result = await ctx.llm.json(ask); // its HttpErrors (409/403/422/502) say what to fix
		const tx = cleanTransactions(result.data);
		if (tx.length === 0) throw bad("the AI found no transactions in this file");
		const currency = typeof result.data?.currency === "string" && /^[A-Z]{3}$/.test(result.data.currency) ? result.data.currency : "";
		// Only a suggestion: nothing is saved with the document or changed until a person approves it.
		await q(`UPDATE ${T("inbox_extractions")} SET status = 'rejected', decided_by = $2, decided_at = now() WHERE file_id = $1 AND status = 'pending'`, [f.id, req.user.username]);
		const { rows } = await q(
			`INSERT INTO ${T("inbox_extractions")} (file_id, model, currency, instructions, transactions, created_by) VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING id`,
			[f.id, String(result.model ?? "").slice(0, 200), currency, typeof extra === "string" ? extra.trim() : "", JSON.stringify(tx), req.user.username],
		);
		ctx.log.info("data extracted for review", { file: String(f.id), extraction: String(rows[0].id), transactions: tx.length, by: req.user.username });
		await syncNotice();
		return ctx.response(201, await getExtraction(rows[0].id));
	});

	async function getExtraction(id) {
		if (!/^\d+$/.test(String(id))) throw new ctx.HttpError(404, "no such extraction");
		const { rows } = await q(
			`SELECT e.id, e.file_id, f.name AS file_name, f.document_id, e.status, e.currency, e.instructions, e.transactions AS rows, e.created_by, e.created_at, e.decided_by, e.decided_at
			   FROM ${T("inbox_extractions")} e JOIN ${T("inbox_files")} f ON f.id = e.file_id WHERE e.id = $1`,
			[id],
		);
		if (!rows[0]) throw new ctx.HttpError(404, "no such extraction");
		return rows[0];
	}

	// GET /extractions?status=pending|approved|rejected|all: suggestions to review (without their rows).
	ctx.route("GET", "/extractions", async (req) => {
		const status = req.query.get("status") || "pending";
		if (!["pending", "approved", "rejected", "all"].includes(status)) throw bad("status must be pending, approved, rejected or all");
		const { rows } = await q(
			`SELECT e.id, e.file_id, f.name AS file_name, e.status, e.currency, jsonb_array_length(e.transactions) AS transactions, e.created_by, e.created_at, e.decided_by, e.decided_at
			   FROM ${T("inbox_extractions")} e JOIN ${T("inbox_files")} f ON f.id = e.file_id WHERE ($1 = 'all' OR e.status = $1) ORDER BY e.id DESC LIMIT 200`,
			[status],
		);
		return { data: rows };
	});

	ctx.route("GET", "/extractions/:id", async (req) => getExtraction(req.params.id));

	// POST /extractions/:id/approve {rows?}: the person's go-ahead, with their edits. The transactions
	// are saved with the original document in Ledger (its extracted data, for every module); the
	// file stays in the inbox, ready to be staged as a statement straight from them.
	ctx.route("POST", "/extractions/:id/approve", async (req) => {
		const e = await getExtraction(req.params.id);
		if (e.status !== "pending") throw new ctx.HttpError(409, `this suggestion was already ${e.status}`);
		let tx = e.rows;
		if (req.body?.rows !== undefined) {
			try {
				tx = checkRows(req.body.rows);
			} catch (err) {
				throw bad(err.message);
			}
		}
		if (tx.length === 0) throw bad("there are no transactions left; reject the suggestion instead");
		const f = await getFile(e.file_id);
		if (f.document_id == null) throw new ctx.HttpError(410, MISSING);
		// Claimed first, so two approvals can't both save.
		const { rowCount } = await q(
			`UPDATE ${T("inbox_extractions")} SET status = 'approved', decided_by = $2, decided_at = now(), transactions = $3::jsonb WHERE id = $1 AND status = 'pending'`,
			[e.id, req.user.username, JSON.stringify(tx)],
		);
		if (rowCount === 0) throw new ctx.HttpError(409, "this suggestion was already decided");
		try {
			await ctx.documents.setExtracted(f.document_id, { data: rowsData(tx, { currency: e.currency, approvedBy: req.user.username }) }, req.user);
		} catch (err) {
			await q(`UPDATE ${T("inbox_extractions")} SET status = 'pending', decided_by = NULL, decided_at = NULL WHERE id = $1`, [e.id]);
			if (notFound404(err)) throw new ctx.HttpError(410, MISSING);
			throw err;
		}
		await learnKept(f.id, "sent", req.user.username);
		ctx.log.info("extraction approved", { extraction: String(e.id), file: String(f.id), document: String(f.document_id), transactions: tx.length, by: req.user.username });
		await syncNotice();
		return { ...(await getFile(f.id)), transactions: tx.length, extraction: e.id };
	});

	ctx.route("POST", "/extractions/:id/reject", async (req) => {
		const e = await getExtraction(req.params.id);
		if (e.status !== "pending") throw new ctx.HttpError(409, `this suggestion was already ${e.status}`);
		await q(`UPDATE ${T("inbox_extractions")} SET status = 'rejected', decided_by = $2, decided_at = now() WHERE id = $1 AND status = 'pending'`, [e.id, req.user.username]);
		await syncNotice();
		return getExtraction(e.id);
	});

	// DELETE /extractions/:id: root mode only. What the AI read is otherwise kept once decided.
	ctx.route("DELETE", "/extractions/:id", async (req) => {
		if (!inRoot(req)) throw new ctx.HttpError(403, "an extraction can only be deleted in root mode");
		const e = await getExtraction(req.params.id);
		await ctx.root.remove(req, "inbox_extractions", e.id, `${ctx.name}: deleted what the AI read from ${e.file_name}`);
		await syncNotice();
	});

	// GET /inbox/:id/transactions: the transactions read out of the file (Ledger's extracted data), as rows
	// {date, description, amount, balance}: for the page to show, and to make a CSV from.
	ctx.route("GET", "/inbox/:id/transactions", async (req) => {
		const f = await getReadyFile(req.params.id);
		const x = await files.extractedOf(f.document_id);
		return { id: f.id, name: f.name, currency: typeof x?.data?.currency === "string" ? x.data.currency : "", rows: rowsFromData(x?.data), read_by: x?.module_id ?? null };
	});

	// ---------------------------------------------------------------------
	// What the email check learned (lib/learn.mjs), and the training file
	// ---------------------------------------------------------------------

	ctx.route("GET", "/training", async () => {
		const [{ rows: counts }, { rows: senders }, { rows: examples }] = await Promise.all([
			q(`SELECT count(*) FILTER (WHERE label < 0)::int AS deleted, count(*) FILTER (WHERE label > 0)::int AS kept FROM ${T("mail_training")}`),
			q(
				`SELECT substr(f, 6) AS sender, count(*) FILTER (WHERE label < 0)::int AS deleted, count(*) FILTER (WHERE label > 0)::int AS kept
				   FROM ${T("mail_training")}, unnest(features) AS f WHERE f LIKE 'from:%'
				  GROUP BY 1 ORDER BY 2 DESC, 3 DESC, 1 LIMIT 100`,
			),
			q(`SELECT id, label, sender, subject, file_name, source, created_by, created_at FROM ${T("mail_training")} ORDER BY id DESC LIMIT 200`),
		]);
		return { deleted: counts[0]?.deleted ?? 0, kept: counts[0]?.kept ?? 0, senders, examples };
	});

	// GET /training/file: the training file (every example), to keep or load elsewhere.
	ctx.route("GET", "/training/file", async () => {
		const { rows } = await q(`SELECT label, features, sender, subject, file_name, source, created_at FROM ${T("mail_training")} ORDER BY id`);
		return { format: TRAINING_FORMAT, version: 1, module: ctx.id, exported_at: new Date().toISOString(), examples: rows };
	});

	// POST /training/file {format, examples}: load a training file; examples already known are skipped.
	ctx.route("POST", "/training/file", async (req) => {
		let examples;
		try {
			examples = readTrainingFile(req.body);
		} catch (err) {
			throw bad(err.message);
		}
		const { rowCount } = await q(
			`INSERT INTO ${T("mail_training")} (label, features, sender, subject, file_name, source, created_by)
			 SELECT x.label, x.features, x.sender, x.subject, x.file_name, x.source, $2
			   FROM (SELECT (e->>'label')::smallint AS label, ARRAY(SELECT jsonb_array_elements_text(e->'features')) AS features,
			                e->>'sender' AS sender, e->>'subject' AS subject, e->>'file_name' AS file_name, e->>'source' AS source
			           FROM jsonb_array_elements($1::jsonb) AS e) x
			  WHERE NOT EXISTS (SELECT 1 FROM ${T("mail_training")} t WHERE t.label = x.label AND t.features = x.features)`,
			[JSON.stringify(examples), req.user.username],
		);
		return { added: rowCount, skipped: examples.length - rowCount };
	});

	ctx.route("DELETE", "/training/:id", async (req) => {
		if (!/^\d+$/.test(req.params.id)) throw new ctx.HttpError(404, "no such example");
		if (inRoot(req)) return void (await ctx.root.remove(req, "mail_training", req.params.id, `${ctx.name}: deleted something the email check learned`));
		const { rowCount } = await q(`DELETE FROM ${T("mail_training")} WHERE id = $1`, [req.params.id]);
		if (!rowCount) throw new ctx.HttpError(404, "no such example");
	});

	// POST /training/forget {sender}: forget everything learned about one sender ({"all": true}: everything).
	ctx.route("POST", "/training/forget", async (req) => {
		const sender = req.body?.sender;
		if (sender !== undefined && (typeof sender !== "string" || sender.length > 300)) throw bad("sender must be an email address");
		if (!sender && req.body?.all !== true) throw bad('give a sender, or {"all": true} to forget everything');
		const { rowCount } = sender
			? await q(`DELETE FROM ${T("mail_training")} WHERE $1 = ANY(features)`, [`from:${sender.toLowerCase()}`])
			: await q(`DELETE FROM ${T("mail_training")}`);
		return { forgotten: rowCount };
	});

	// GET /app: the phone app, for the Scan tab and for the app itself.
	ctx.route("GET", "/app", async () => ({
		version: ctx.version,
		apk_url: `https://github.com/${APP_REPO}/releases/latest/download/${APP_APK}`,
		releases_url: `https://github.com/${APP_REPO}/releases/latest`,
	}));

	// GET /me: who's asking, for the page.
	ctx.route("GET", "/me", async (req) => ({ username: req.user.username, role: req.user.role, root: inRoot(req), ledger: ctx.ledgerVersion, version: ctx.version, module: ctx.id, name: ctx.name }));

	// Root mode can't be left while one of the inbox's records is truly broken: a file with no document.
	if (typeof ctx.root?.onCheck === "function") {
		ctx.root.onCheck(async () => {
			const { rows } = await q(`SELECT id, name FROM ${T("inbox_files")} WHERE status <> 'uploading' AND document_id IS NULL ORDER BY id LIMIT 20`);
			return rows.map((r) => `inbox file ${r.id} (${r.name}) has no document; delete it on the Inbox tab.`);
		});
	}

	// ---------------------------------------------------------------------
	// Housekeeping: abandoned uploads (their rows and their temporary pieces), and old sent or
	// archived files when Settings say so
	// ---------------------------------------------------------------------

	// Background work runs in the main books; this does it in every organization's (each has its own inbox).
	async function eachOrg(what, fn) {
		try {
			await ctx.orgs.forEach(async (org) => {
				try {
					await fn(org);
				} catch (err) {
					ctx.log.warn(`${what} failed`, { org: String(org.id), err: String(err?.message || err) });
				}
			});
		} catch (err) {
			ctx.log.warn(`${what} failed`, { err: String(err?.message || err) });
		}
	}

	async function cleanUp() {
		await eachOrg("inbox clean-up", async (org) => {
			const { keepDays } = await options(); // each organization has its own settings
			const a = await q(`DELETE FROM ${T("inbox_files")} WHERE status = 'uploading' AND received_at < now() - make_interval(hours => $1) RETURNING id`, [STALE_UPLOAD_HOURS]);
			for (const r of a.rows) await chunks.discard(org.id, r.id);
			// Pieces of uploads that have no row any more (deleted, or left by a restart).
			const { rows: live } = await q(`SELECT id FROM ${T("inbox_files")} WHERE status = 'uploading'`);
			const swept = await chunks.sweep(org.id, new Set(live.map((r) => String(r.id))));
			const b = keepDays > 0 ? await q(`DELETE FROM ${T("inbox_files")} WHERE status IN ('sent', 'archived') AND updated_at < now() - make_interval(days => $1) RETURNING document_id, document_added_here, sent_at`, [keepDays]) : { rowCount: 0, rows: [] };
			for (const r of b.rows) await discard(r);
			if (a.rowCount + b.rowCount + swept > 0) {
				ctx.log.info("inbox cleaned up", { org: String(org.id), abandoned_uploads: a.rowCount, upload_pieces_swept: swept, old_files: b.rowCount });
				await syncNotice();
			}
		});
	}
	const timer = setInterval(() => cleanUp().catch(() => {}), 60 * 60 * 1000);
	timer.unref?.();
	// Not awaited: register must finish quickly.
	cleanUp()
		.then(() => eachOrg("dashboard update", syncNotice))
		.catch(() => {});

	// ---------------------------------------------------------------------
	// Email (lib/mail.mjs): the one mail check, feeding the inbox
	// ---------------------------------------------------------------------

	registerMail(ctx, { q, T, saveFile, maxBytes: async () => (await options()).maxBytes, syncNotice, learnKept, getFile, fileBytes, hold: h.mailHold });

	return { saveFile, options, syncNotice, getFile, chunks };
}

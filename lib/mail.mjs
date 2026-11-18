// Email into the inbox: the module's one mail check. On a schedule it reads new
// messages from the mailbox Ledger is connected to (ctx.mail: the IMAP/SMTP
// account under Settings → Mail, e.g. Proton Mail Bridge, or Gmail) and saves
// the documents in bill-like emails (PDFs, statements, photos) as inbox files,
// each one a document in Ledger. With "save emails without attachments" on,
// such an email itself is saved as an .eml file. No AI here: the inbox's Send
// panel is where files are read, with a person approving. No mail protocol
// here either: Ledger does that.
//
// Nothing is imported twice: each message is looked at once per mailbox
// (mail_seen, which the hand-over from the Import module brings along), a
// file whose bytes are already in the inbox or already a bill's or a
// statement's document is left out, and a saved email that became a bill
// before is recognised by its Message-ID. While the Import module's data
// waits to be taken over (lib/adopt.mjs), the check holds off.

import { createHash } from "node:crypto";
import { parseEml } from "./eml.mjs";
import { features, learner } from "./learn.mjs";

const MAX_MESSAGES_PER_CHECK = 200;
const SEARCH_PAGE = 100; // ctx.mail.search returns at most 100, newest first
const MAX_SEARCH_PAGES = 10;
/** A date range import (Settings → the module → Email) may go further than a check. */
const MAX_RANGE_DAYS = 3660;
const MAX_RANGE_PAGES = 100;
const MAX_RANGE_MESSAGES = 5000;
/** Pictures smaller than this are logos and signatures, not photographed receipts. */
const MIN_IMAGE_BYTES = 20_000;
const MAX_IMAGES = 5;
const DOC_RE = /\.(pdf|csv|tsv|ofx|qfx|qbo|xlsx?|txt)$/i;
const DOC_TYPE_RE = /^(application\/(pdf|x-ofx|vnd\.intu\.qfx|x-qfx|vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet)|text\/(csv|tab-separated-values))\b/i;
const IMAGE_RE = /\.(jpe?g|png|gif|webp)$/i;
const IMAGE_TYPE_RE = /^image\/(jpeg|png|gif|webp)\b/i;
const NAME_BAD = /[\u0000-\u001f/\\]/g;

const addresses = (s) => new Set(String(s ?? "").toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? []);

/** Mail you sent (from you and not to you) isn't mail you received. */
export function sentByMe({ from = "", to = "", cc = "" }, account = "") {
	const me = String(account ?? "").trim().toLowerCase();
	if (!me) return false;
	return addresses(from).has(me) && !addresses(`${to} ${cc}`).has(me);
}

/** Whether an email mentions a keyword (subject, sender, text, attachment names). No keywords: every email. */
export function looksLikeBill(email, keywords) {
	if (keywords.length === 0) return true;
	const hay = `${email.subject}\n${email.from}\n${String(email.text ?? "").slice(0, 20_000)}\n${email.attachments.map((a) => a.filename).join(" ")}`.toLowerCase();
	return keywords.some((k) => hay.includes(k.toLowerCase()));
}

/** An HTML email as text a person can read: paragraphs and line breaks kept, tags and scripts gone. */
export function htmlToReadable(html) {
	const named = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
	return String(html ?? "")
		.replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)\s*>/gi, "\n")
		.replace(/<(td|th)\b[^>]*>/gi, "\t")
		.replace(/<li\b[^>]*>/gi, "• ")
		.replace(/<[^>]*>/g, "")
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*|#39);/gi, (all, e) => {
			if (named[e.toLowerCase()] !== undefined) return named[e.toLowerCase()];
			const n = e[0] === "#" ? (e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : NaN;
			return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
		})
		.replace(/[ \t\u00a0]+/g, (w) => (w.includes("\t") ? "  " : " "))
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function htmlToText(html) {
	return String(html ?? "")
		.replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();
}

const emlName = (subject) => `${(subject || "email").replace(NAME_BAD, "-").replace(/[<>:"|?*]/g, "").trim().slice(0, 200) || "email"}.eml`;

/**
 * The attachments worth importing, from their names, types and sizes (before any is downloaded):
 * [{ attachmentId, name, type }]. Documents (PDF, CSV, OFX, spreadsheets), and up to 5 pictures big
 * enough to be a photographed receipt, not a logo.
 */
export function emailCandidates(attachments, maxBytes) {
	const out = [];
	let images = 0;
	for (const a of attachments ?? []) {
		const filename = String(a.filename ?? "");
		const type = String(a.mimeType ?? "").split(";")[0].trim().toLowerCase();
		const size = Number(a.size) || 0;
		if (size > maxBytes) continue;
		let name = filename;
		if (DOC_RE.test(filename) || DOC_TYPE_RE.test(type)) name ||= type === "application/pdf" ? "attachment.pdf" : "attachment";
		else if (IMAGE_RE.test(filename) || IMAGE_TYPE_RE.test(type)) {
			if (size < MIN_IMAGE_BYTES || images >= MAX_IMAGES) continue;
			images++;
			name ||= `photo.${type.split("/")[1] === "jpeg" ? "jpg" : type.split("/")[1] || "jpg"}`;
		} else continue;
		out.push({ attachmentId: a.attachmentId, name: name.replace(NAME_BAD, "-").trim().slice(-255) || "attachment", type: type || "application/octet-stream" });
	}
	return out;
}

const gone = (err) => err?.status === 404 || err?.constructor?.name === "NotFoundError";
const day = (d) => new Date(d).toISOString().slice(0, 10);

/** h: { q, T, saveFile(name, type, data, opts), maxBytes(), syncNotice(), learnKept(fileIds, source, by), getFile(id), fileBytes(file), hold() } */
export function registerMail(ctx, h) {
	const { q, T } = h;

	async function mailSettings() {
		// Settings are per organization (Ledger 0.11.1). "auto" reads the mailbox in the main books
		// only, so another organization doesn't import the same mail again.
		const v = await ctx.settings.get();
		// "gmail" and "imap" are choices from before Ledger had one mailbox for every module.
		const setting = ["gmail", "imap", "mail"].includes(v.mail_source) ? "mail" : v.mail_source === "off" ? "off" : "auto";
		const source = setting === "auto" ? ((await ctx.orgs.current()).id === 1 ? "mail" : "off") : setting;
		const num = (x, d, lo, hi) => (typeof x === "number" && Number.isFinite(x) ? Math.min(Math.max(Math.round(x), lo), hi) : d);
		return {
			source,
			setting,
			keywords: String(v.mail_keywords ?? "").split(",").map((k) => k.trim()).filter(Boolean),
			lookback_days: num(v.mail_lookback_days, 30, 1, 365),
			interval: num(v.mail_interval, 60, 0, 10080),
			save_body: v.mail_save_body !== false,
		};
	}

	/** What's missing before mail can be read, or "". */
	async function missing(m, st = null) {
		if (m.source === "off") {
			return m.setting === "auto"
				? `email isn't read in this organization (outside the main books that's the default); an admin can turn it on under Settings → ${ctx.name} here`
				: `reading email is turned off under Settings → ${ctx.name}`;
		}
		// The Import module's data hasn't been taken over yet: reading mail now could import what it already has.
		const held = await h.hold?.();
		if (held) return held;
		st ??= await ctx.mail.status();
		if (!st.connected) return "no mailbox is connected; an admin can connect one under Settings → Mail";
		if (!st.canRead) return `${ctx.name} isn't allowed to read mail; an admin can allow it under Settings → Mail`;
		return "";
	}

	async function getState() {
		const { rows } = await q(`SELECT value FROM ${T("module_state")} WHERE key = 'mail'`);
		return rows[0]?.value ?? {};
	}
	async function saveState(patch) {
		await q(
			`INSERT INTO ${T("module_state")} (key, value) VALUES ('mail', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = ${T("module_state")}.value || EXCLUDED.value, updated_at = now()`,
			[JSON.stringify(patch)],
		);
	}

	/** Which mailbox the ids belong to: ids from one mailbox mean nothing in another. */
	const folderOf = (st) => `${st.kind}:${String(st.account ?? "").toLowerCase()}`.slice(0, 200);

	/**
	 * Ids of the messages from a date (and before another, by day, if given), oldest first. The
	 * search gives 100 at a time, newest first, so walk back by date.
	 */
	async function messagesSince(since, { before: until = null, pages = MAX_SEARCH_PAGES } = {}) {
		const seen = new Map(); // id -> date
		let before = until ? day(until) : undefined;
		for (let page = 0; page < pages; page++) {
			const { messages } = await ctx.mail.search({ since: day(since), ...(before ? { before } : {}), max: SEARCH_PAGE });
			let fresh = 0;
			let oldest = null;
			for (const m of messages) {
				const t = Date.parse(m.date) || 0;
				if (oldest === null || (t && t < oldest)) oldest = t;
				if (!seen.has(m.id)) {
					seen.set(m.id, t);
					fresh++;
				}
			}
			if (messages.length < SEARCH_PAGE || fresh === 0 || !oldest) break;
			before = day(oldest + 86_400_000); // "before" is by day: ask again up to and including the oldest day seen
		}
		return [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
	}

	const senderName = (from) => (/^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1] || [...addresses(from)][0] || "email").trim();
	const noteFor = (email) => `Email from ${email.from || "an unknown sender"}${email.subject ? `: "${email.subject}"` : ""}`.slice(0, 1000);
	const asEmail = (m) => ({ subject: m.subject ?? "", from: m.from ?? "", to: m.to ?? "", cc: m.cc ?? "", date: m.date ?? "", text: m.text || htmlToText(m.html), attachments: m.attachments ?? [] });
	const dateOf = (email) => (Date.parse(email.date) ? new Date(Date.parse(email.date)).toISOString() : null);

	let checking = false;

	/** Whether a file with these bytes is in the inbox already (sent, archived or waiting). */
	async function haveBytes(data) {
		const sha = createHash("sha256").update(data).digest("hex");
		const { rows } = await q(`SELECT id FROM ${T("inbox_files")} WHERE sha256 = $1 LIMIT 1`, [sha]);
		return rows.length > 0;
	}

	/** Reads one message and saves its documents as inbox files → { outcome, saved, duplicates, reason, email }. */
	async function importMessage(id, { m, st, maxBytes, learned, by, user }) {
		let outcome;
		let saved = 0;
		let duplicates = 0;
		let reason = "";
		let email = { subject: "", from: "" };
		let msg = null;
		try {
			msg = await ctx.mail.message(id);
		} catch (err) {
			if (!gone(err)) throw err;
			return { outcome: "gone", saved, duplicates, reason, email }; // moved or deleted since the search
		}
		email = asEmail(msg);
		if (sentByMe(email, st.account)) return { outcome: "sent", saved, duplicates, reason, email };
		if (!looksLikeBill(email, m.keywords)) return { outcome: "filtered", saved, duplicates, reason, email };
		const opts = { origin: "email", detail: senderName(email.from), note: noteFor(email), by, user, mail: { folder: folderOf(st), uid: id } };
		const save = async (name, type, data, feats) => {
			// The same file came before (another email, the browser, …), or is a bill's or a statement's document already.
			if ((await haveBytes(data)) || (await h.saveFile(name, type, data, { ...opts, features: feats, skipKnown: true })) === null) duplicates++;
			else saved++;
		};
		const candidates = emailCandidates(email.attachments, maxBytes);
		const skipped = [];
		for (const c of candidates) {
			const feats = features(email, c);
			const j = learned.judge(feats);
			if (j.skip) {
				skipped.push(`${c.name}: ${j.reason}`);
				continue;
			}
			const data = await ctx.mail.attachment(id, c.attachmentId);
			if (!data?.length || data.length > maxBytes) continue;
			await save(c.name, data.subarray(0, 5).toString("latin1") === "%PDF-" ? "application/pdf" : c.type, data, feats);
		}
		reason = skipped.join("; ").slice(0, 2000);
		if (saved > 0) outcome = "files";
		else if (duplicates > 0) outcome = "duplicate";
		else if (candidates.length > 0) outcome = skipped.length ? "learned_skip" : "no_document";
		else if (m.save_body) {
			const feats = features(email, null);
			const j = learned.judge(feats);
			if (j.skip) {
				outcome = "learned_skip";
				reason = j.reason;
			} else {
				const raw = await ctx.mail.raw(id);
				if (raw.length > maxBytes) outcome = "no_document";
				else {
					await save(emlName(email.subject), "message/rfc822", raw, feats);
					outcome = saved ? "email_saved" : "duplicate";
				}
			}
		} else outcome = "no_document";
		return { outcome, saved, duplicates, reason, email, skipped: skipped.length };
	}

	const emptyResult = () => ({ looked_at: 0, files: 0, emails_saved: 0, no_document: 0, filtered: 0, learned_skip: 0, files_skipped: 0, duplicates: 0, already_seen: 0, sent: 0, gone: 0, remaining: 0 });

	/**
	 * Imports the messages from `since` (to before `before`, by day) that this mailbox hasn't
	 * given before; each message once (mail_seen), each file's bytes once (the inbox's sha256).
	 */
	async function importRange({ since, before = null, limit, pages, by, user, onProgress = () => {} }) {
		const result = emptyResult();
		const m = await mailSettings();
		const st = await ctx.mail.status();
		const why = await missing(m, st);
		if (why) throw new Error(why);
		const maxBytes = await h.maxBytes();
		const folder = folderOf(st);
		const ids = await messagesSince(since, { before, pages });
		const { rows: seen } = await q(`SELECT uid FROM ${T("mail_seen")} WHERE folder = $1 AND uidvalidity = 0 AND uid = ANY($2::text[])`, [folder, ids]);
		const done = new Set(seen.map((r) => r.uid));
		const todo = ids.filter((k) => !done.has(k));
		result.already_seen = ids.length - todo.length;
		// What you taught it: deleted ("unwanted") and sent-on ("wanted") email files.
		const learned = learner((await q(`SELECT label, features FROM ${T("mail_training")} ORDER BY id DESC LIMIT 5000`)).rows);
		result.remaining = Math.max(0, todo.length - limit);
		const batch = todo.slice(0, limit);
		onProgress(0, batch.length, result);
		for (const id of batch) {
			const r = await importMessage(id, { m, st, maxBytes, learned, by, user });
			await q(
				`INSERT INTO ${T("mail_seen")} (folder, uidvalidity, uid, outcome, files, subject, mail_from, reason, mail_date) VALUES ($1, 0, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
				[folder, id, r.outcome, r.saved, r.email.subject.slice(0, 300), r.email.from.slice(0, 300), r.reason, dateOf(r.email)],
			);
			result.looked_at++;
			result.files_skipped += r.skipped ?? 0;
			result.duplicates += r.duplicates;
			if (r.outcome === "files") result.files += r.saved;
			else if (r.outcome === "email_saved") result.emails_saved++;
			else if (r.outcome !== "duplicate") result[r.outcome]++;
			onProgress(result.looked_at, batch.length, result);
		}
		if (result.files + result.emails_saved > 0) await h.syncNotice();
		return { result, mailbox: st.kind };
	}

	async function checkMail({ trigger = "schedule", by = "email", user } = {}) {
		if (checking) return { skipped: "a check is already running" };
		checking = true;
		const started = new Date();
		let result = emptyResult();
		try {
			const m = await mailSettings();
			const out = await importRange({ since: new Date(Date.now() - m.lookback_days * 86_400_000), limit: MAX_MESSAGES_PER_CHECK, by, user, onProgress: (_, __, r) => (result = r) });
			result = out.result;
			await saveState({ last_check_at: started.toISOString(), last_ok_at: new Date().toISOString(), error: null, result, trigger, mailbox: out.mailbox });
			await ctx.dashboard.remove("mail-error", "notification").catch(() => {});
			ctx.log.info("mail checked", { ...result, trigger });
			return result;
		} catch (err) {
			const error = String(err?.message || err).slice(0, 500);
			await saveState({ last_check_at: started.toISOString(), error, result, trigger }).catch(() => {});
			await ctx.dashboard.notify({ key: "mail-error", title: `${ctx.name} couldn't check email`, body: error, level: "danger", link: `/apps/${ctx.id}?tab=inbox` }).catch(() => {});
			ctx.log.warn("mail check failed", { err: error, trigger });
			return { ...result, error };
		} finally {
			checking = false;
		}
	}

	// ---------------------------------------------------------------------
	// Importing a date range (Settings → the module → Email): in the background,
	// in the request's organization; the page polls GET /mail/range.
	// ---------------------------------------------------------------------

	const rangeJobs = new Map(); // organization id -> the last range import there (in memory)
	const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
	const validDate = (s) => typeof s === "string" && DATE_RE.test(s) && day(`${s}T00:00:00Z`) === s;

	async function startRange({ from, to }, user) {
		if (!validDate(from) || !validDate(to)) throw new ctx.HttpError(422, "give from and to as dates (YYYY-MM-DD)");
		if (from > to) throw new ctx.HttpError(422, "the range starts after it ends");
		const today = day(Date.now());
		if (from > today) throw new ctx.HttpError(422, "the range starts in the future");
		if (Date.parse(to) - Date.parse(from) > MAX_RANGE_DAYS * 86_400_000) throw new ctx.HttpError(422, `a range can be at most ${MAX_RANGE_DAYS} days; import a longer time in parts`);
		const m = await mailSettings();
		const why = await missing(m);
		if (why) throw new ctx.HttpError(409, why);
		if (checking) throw new ctx.HttpError(409, "email is being checked right now; try again in a minute");
		const org = (await ctx.orgs.current()).id;
		const job = { status: "running", from, to, done: 0, total: 0, result: emptyResult(), error: null, by: user.username, started_at: new Date().toISOString(), finished_at: null };
		rangeJobs.set(org, job);
		checking = true;
		// Not awaited: runs on in the background, in this request's organization.
		(async () => {
			try {
				const out = await importRange({
					since: `${from}T00:00:00Z`,
					before: Date.parse(`${to}T00:00:00Z`) + 86_400_000, // "to" is included
					limit: MAX_RANGE_MESSAGES,
					pages: MAX_RANGE_PAGES,
					by: user.username,
					user,
					onProgress: (done, total, r) => Object.assign(job, { done, total, result: r }),
				});
				job.result = out.result;
				job.status = "done";
				ctx.log.info("mail range imported", { from, to, ...out.result, by: user.username });
			} catch (err) {
				job.status = "error";
				job.error = String(err?.message || err).slice(0, 500);
				ctx.log.warn("mail range import failed", { from, to, err: job.error });
			} finally {
				job.finished_at = new Date().toISOString();
				checking = false;
			}
		})();
		return job;
	}

	// POST /mail/range {from, to}: import the email of those days (both included), leaving out what's already here.
	ctx.route("POST", "/mail/range", async (req) => {
		const b = req.body ?? {};
		return ctx.response(202, await startRange({ from: b.from, to: b.to }, req.user));
	});

	// GET /mail/range: the last range import in this organization, or null.
	ctx.route("GET", "/mail/range", async () => {
		const m = await mailSettings();
		const st = m.source === "off" ? null : await ctx.mail.status().catch(() => null);
		return { job: rangeJobs.get((await ctx.orgs.current()).id) ?? null, missing: await missing(m, st ?? undefined), mailbox: st?.kind ?? null, account: st?.account ?? null, checking };
	});

	// ---------------------------------------------------------------------
	// Looking at one email before importing it: the email, its attachments
	// (opened without importing them), then import what the person ticks, or
	// leave it. Used for the emails the check skipped from what it learned.
	// ---------------------------------------------------------------------

	const MAX_TEXT = 100_000;
	const idOf = (x, what = "id") => {
		if (typeof x !== "string" || !x || x.length > 300) throw new ctx.HttpError(422, `give the email's ${what}`);
		return x;
	};

	/** The connected mailbox, ready to read → { m, st, folder }; 409 when it isn't, or when `folder` is another mailbox. */
	async function mailbox(folder) {
		const m = await mailSettings();
		const st = await ctx.mail.status();
		const why = await missing(m, st);
		if (why) throw new ctx.HttpError(409, why);
		if (folder != null && folder !== "" && folderOf(st) !== folder) {
			throw new ctx.HttpError(409, "this email came from another mailbox than the one Ledger is connected to now; it can't be opened again");
		}
		return { m, st, folder: folderOf(st) };
	}

	async function fetchMessage(id) {
		try {
			return await ctx.mail.message(id);
		} catch (err) {
			if (gone(err)) throw new ctx.HttpError(404, "the email isn't in the mailbox any more (or the mailbox was rebuilt since)");
			throw err;
		}
	}

	/** One email for the page: who, when, its text and attachments (which ones the check would import). */
	async function viewMessage({ id, folder: want }) {
		const { folder } = await mailbox(want);
		const msg = await fetchMessage(id);
		const email = asEmail(msg);
		const maxBytes = await h.maxBytes();
		const suggested = new Set(emailCandidates(email.attachments, maxBytes).map((c) => c.attachmentId));
		const text = (msg.text ? String(msg.text).replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : htmlToReadable(msg.html)).slice(0, MAX_TEXT);
		const { rows } = await q(`SELECT outcome, files, reason FROM ${T("mail_seen")} WHERE folder = $1 AND uid = $2 LIMIT 1`, [folder, id]);
		return {
			id,
			folder,
			date: dateOf(email),
			from: email.from,
			to: email.to,
			cc: email.cc,
			subject: email.subject,
			text,
			text_cut: text.length >= MAX_TEXT,
			attachments: email.attachments.map((a) => ({
				attachment_id: String(a.attachmentId),
				filename: String(a.filename ?? "") || "attachment",
				content_type: String(a.mimeType ?? "").split(";")[0].trim().toLowerCase() || "application/octet-stream",
				size_bytes: Number(a.size) || 0,
				suggested: suggested.has(a.attachmentId),
				too_large: (Number(a.size) || 0) > maxBytes,
			})),
			max_bytes: maxBytes,
			seen: rows[0] ?? null,
		};
	}

	/** One attachment's bytes, base64, to open it in the browser without importing it. */
	async function attachmentOf({ id, attachment, folder: want }) {
		await mailbox(want);
		const msg = await fetchMessage(id);
		const a = (msg.attachments ?? []).find((x) => String(x.attachmentId) === attachment);
		if (!a) throw new ctx.HttpError(404, "the email has no such attachment");
		const maxBytes = await h.maxBytes();
		if ((Number(a.size) || 0) > maxBytes) throw new ctx.HttpError(413, `the attachment is larger than ${maxBytes / 1024 / 1024} MB (the limit is under Settings → ${ctx.name})`);
		const data = await ctx.mail.attachment(id, a.attachmentId);
		if (!data?.length) throw new ctx.HttpError(404, "the attachment is empty");
		if (data.length > maxBytes) throw new ctx.HttpError(413, `the attachment is larger than ${maxBytes / 1024 / 1024} MB`);
		const type = data.subarray(0, 5).toString("latin1") === "%PDF-" ? "application/pdf" : String(a.mimeType ?? "").split(";")[0].trim().toLowerCase() || "application/octet-stream";
		return { name: String(a.filename ?? "") || "attachment", content_type: type, size_bytes: data.length, data: data.toString("base64") };
	}

	/**
	 * Imports one email into the inbox, whatever the keywords and what the check learned, and
	 * teaches it that such files are wanted. `attachments` (ids) and `email` (the .eml itself) say
	 * what; neither given: what the check would import (its documents, else the email itself).
	 * Files already in the inbox (same bytes) aren't added twice.
	 */
	async function importChosen({ id, folder: want, attachments, email: wantEml }, user) {
		const by = user.username;
		const { folder } = await mailbox(want);
		const msg = await fetchMessage(id);
		const email = asEmail(msg);
		const opts = { origin: "email", detail: senderName(email.from), note: noteFor(email), by, user, mail: { folder, uid: id } };
		const maxBytes = await h.maxBytes();
		const docs = [];
		const tooBig = (n) => new ctx.HttpError(413, `${n} is larger than ${maxBytes / 1024 / 1024} MB (the limit is under Settings → ${ctx.name})`);
		if (attachments === undefined && wantEml === undefined) {
			for (const c of emailCandidates(email.attachments, maxBytes)) {
				const data = await ctx.mail.attachment(id, c.attachmentId);
				if (data?.length && data.length <= maxBytes) docs.push({ name: c.name, type: c.type, data, feats: features(email, c) });
			}
			if (docs.length === 0) wantEml = true;
		} else {
			for (const aid of attachments ?? []) {
				const a = email.attachments.find((x) => String(x.attachmentId) === aid);
				if (!a) throw new ctx.HttpError(422, "the email has no such attachment (open it again)");
				const name = (String(a.filename ?? "") || "attachment").replace(NAME_BAD, "-").trim().slice(-255) || "attachment";
				if ((Number(a.size) || 0) > maxBytes) throw tooBig(name);
				const data = await ctx.mail.attachment(id, a.attachmentId);
				if (!data?.length) continue;
				if (data.length > maxBytes) throw tooBig(name);
				const type = data.subarray(0, 5).toString("latin1") === "%PDF-" ? "application/pdf" : String(a.mimeType ?? "").split(";")[0].trim().toLowerCase() || "application/octet-stream";
				docs.push({ name, type, data, feats: features(email, { attachmentId: a.attachmentId, name, type }) });
			}
		}
		if (wantEml) {
			const raw = await ctx.mail.raw(id);
			if (raw.length > maxBytes) throw tooBig("the email");
			docs.push({ name: emlName(email.subject), type: "message/rfc822", data: raw, feats: features(email, null) });
		}
		const ids = [];
		let duplicates = 0;
		for (const d of docs) {
			if (await haveBytes(d.data)) duplicates++;
			else ids.push(await h.saveFile(d.name, d.type, d.data, { ...opts, features: d.feats })); // asked for by a person: taken even if it is a document already
		}
		await q(
			`INSERT INTO ${T("mail_seen")} (folder, uidvalidity, uid, outcome, files, subject, mail_from, reason, mail_date)
			 VALUES ($1, 0, $2, $3, $4, $5, $6, '', $7)
			 ON CONFLICT (folder, uidvalidity, uid) DO UPDATE SET outcome = EXCLUDED.outcome, files = ${T("mail_seen")}.files + EXCLUDED.files, reason = ''`,
			[folder, id, ids.length ? "files" : "duplicate", ids.length, email.subject.slice(0, 300), email.from.slice(0, 300), dateOf(email)],
		);
		await h.learnKept(ids, "import", by);
		await h.syncNotice();
		ctx.log.info("email imported by hand", { files: ids.length, duplicates, by });
		return { files: ids.length, file_ids: ids, duplicates };
	}

	const q1 = (req, k) => req.query?.get?.(k) ?? undefined;

	// GET /mail/message?id=&folder=: one email, to look at before importing it.
	ctx.route("GET", "/mail/message", async (req) => viewMessage({ id: idOf(q1(req, "id")), folder: q1(req, "folder") }));

	// GET /mail/message/attachment?id=&attachment=&folder=: an attachment's bytes (base64), not imported.
	ctx.route("GET", "/mail/message/attachment", async (req) =>
		attachmentOf({ id: idOf(q1(req, "id")), attachment: idOf(q1(req, "attachment"), "attachment"), folder: q1(req, "folder") }));

	// POST /mail/message/import {id, folder?, attachments?: [attachment_id], email?: boolean}: import it into the inbox.
	ctx.route("POST", "/mail/message/import", async (req) => {
		const b = req.body ?? {};
		const id = idOf(b.id);
		if (b.folder !== undefined && (typeof b.folder !== "string" || b.folder.length > 300)) throw new ctx.HttpError(422, "folder must be text");
		if (b.attachments !== undefined && (!Array.isArray(b.attachments) || b.attachments.length > 100 || b.attachments.some((x) => typeof x !== "string" || !x || x.length > 300))) {
			throw new ctx.HttpError(422, "attachments must be a list of attachment ids");
		}
		if (b.email !== undefined && typeof b.email !== "boolean") throw new ctx.HttpError(422, "email must be true or false");
		if ((b.attachments !== undefined || b.email !== undefined) && !(b.attachments?.length) && !b.email) {
			throw new ctx.HttpError(422, "choose at least one attachment, or the email itself");
		}
		return importChosen({ id, folder: b.folder, attachments: b.attachments ? [...new Set(b.attachments)] : undefined, email: b.email }, req.user);
	});

	// ---------------------------------------------------------------------
	// The email behind an inbox file, to look at before sending the file on
	// to Ledger: an .eml file is read from its own bytes; a file taken from an
	// email is shown from the mailbox (read only).
	// ---------------------------------------------------------------------

	const isEml = (f) => /^message\/rfc822\b/i.test(f.content_type || "") || /\.eml$/i.test(f.name || "");

	async function emlOf(f) {
		const MAX = 50 * 1024 * 1024;
		if (Number(f.size_bytes) > MAX) throw new ctx.HttpError(413, "the email is too large to show here; download it instead");
		return parseEml(await h.fileBytes(f));
	}

	async function fileEmail(fileId) {
		const f = await h.getFile(fileId);
		if (isEml(f)) {
			const e = await emlOf(f);
			const text = (e.text ? e.text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim() : htmlToReadable(e.html)).slice(0, MAX_TEXT);
			return {
				source: "file", file_id: f.id, date: e.date || null, from: e.from, to: e.to, cc: e.cc, subject: e.subject, text, text_cut: text.length >= MAX_TEXT,
				attachments: e.attachments.map((a, i) => ({ attachment_id: String(i), filename: a.filename, content_type: a.content_type, size_bytes: a.data.length, suggested: false, too_large: false })),
			};
		}
		if (!f.mail_uid) throw new ctx.HttpError(404, f.origin === "email" ? "this file came from email before it was kept which email; open the mailbox to see it" : "this file didn't come from email");
		const v = await viewMessage({ id: f.mail_uid, folder: f.mail_folder });
		return { ...v, source: "mailbox", file_id: f.id };
	}

	async function fileEmailAttachment(fileId, attachment) {
		const f = await h.getFile(fileId);
		if (isEml(f)) {
			const a = (await emlOf(f)).attachments[Number(attachment)];
			if (!/^\d+$/.test(attachment) || !a) throw new ctx.HttpError(404, "the email has no such attachment");
			const type = a.data.subarray(0, 5).toString("latin1") === "%PDF-" ? "application/pdf" : a.content_type;
			return { name: a.filename, content_type: type, size_bytes: a.data.length, data: a.data.toString("base64") };
		}
		if (!f.mail_uid) throw new ctx.HttpError(404, "this file didn't come from an email that was kept");
		return attachmentOf({ id: f.mail_uid, attachment, folder: f.mail_folder });
	}

	// GET /inbox/:id/email: the email this inbox file is (.eml) or came from, to look at before sending it on.
	ctx.route("GET", "/inbox/:id/email", async (req) => fileEmail(req.params.id));

	// GET /inbox/:id/email/attachment?attachment=: one of that email's attachments, base64.
	ctx.route("GET", "/inbox/:id/email/attachment", async (req) => fileEmailAttachment(req.params.id, idOf(q1(req, "attachment"), "attachment")));

	/** Imports one message the check skipped (or partly skipped), as importChosen does with nothing chosen. */
	async function importSkipped({ folder, uid }, user) {
		const { rows } = await q(`SELECT reason FROM ${T("mail_seen")} WHERE folder = $1 AND uid = $2`, [folder, uid]);
		if (!rows[0] || !rows[0].reason) throw new ctx.HttpError(404, "no such skipped email");
		const r = await importChosen({ id: uid, folder }, user);
		return { files: r.files, file_ids: r.file_ids };
	}

	// GET /mail/skipped: emails (or some of their files) the check skipped because of what it learned.
	ctx.route("GET", "/mail/skipped", async () => {
		const { rows } = await q(
			`SELECT folder, uid, outcome, files, subject, mail_from, reason, seen_at FROM ${T("mail_seen")}
			  WHERE reason <> '' AND seen_at > now() - interval '90 days' ORDER BY seen_at DESC LIMIT 100`,
		);
		return { data: rows };
	});

	// POST /mail/skipped/import {folder, uid}: import it anyway.
	ctx.route("POST", "/mail/skipped/import", async (req) => {
		const b = req.body ?? {};
		if (typeof b.folder !== "string" || !b.folder || b.folder.length > 300 || typeof b.uid !== "string" || !b.uid || b.uid.length > 300) {
			throw new ctx.HttpError(422, "give folder and uid of a skipped email (from GET /mail/skipped)");
		}
		return importSkipped({ folder: b.folder, uid: b.uid }, req.user);
	});

	// GET /mail: the email check, for the page.
	ctx.route("GET", "/mail", async () => {
		const m = await mailSettings();
		const st = m.source === "off" ? null : await ctx.mail.status().catch(() => null);
		return { source: m.source, setting: m.setting, interval: m.interval, mailbox: st?.kind ?? null, account: st?.account ?? null, missing: await missing(m, st ?? undefined), checking, state: await getState() };
	});

	// POST /mail/check: check now.
	ctx.route("POST", "/mail/check", async (req) => {
		const m = await mailSettings();
		const why = await missing(m);
		if (why) throw new ctx.HttpError(409, why);
		return checkMail({ trigger: "manual", by: req.user.username, user: req.user });
	});

	// Every minute: is a check due? Timers run in the main books, so visit each organization.
	const timer = setInterval(async () => {
		try {
			await ctx.orgs.forEach(async () => {
				const m = await mailSettings();
				if (!(m.interval > 0) || checking || (await missing(m))) return;
				const last = Date.parse((await getState()).last_check_at ?? "") || 0;
				if (Date.now() - last >= m.interval * 60_000) await checkMail();
			});
		} catch (err) {
			ctx.log.error("mail scheduler", { err: String(err?.message || err) });
		}
	}, 60_000);
	timer.unref?.();

	return { checkMail, importRange };
}

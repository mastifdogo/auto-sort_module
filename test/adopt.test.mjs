// The hand-over from the Import module (lib/adopt.mjs), against a real PostgreSQL: this module's own
// migrations in mod_categorizer, a stand-in for Import's schema (mod_downloads) beside it, and
// Ledger's module_settings table. Needs a PostgreSQL to create a scratch database in
// (TEST_DATABASE_URL, default the local one) and the pg driver of a Ledger checkout ($LEDGER_DIR,
// or ../Bookeeping, ../Accounting, ../ledger); skipped when either is missing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerAdoption } from "../lib/adopt.mjs";
import { moduleFiles } from "../lib/files.mjs";
import { fakeDocuments, fakeStorage, HttpError } from "./fake-ledger.mjs";
import { scratchDatabase } from "./pg.mjs";

const scratch = () => scratchDatabase({ settingsTable: true });

/** Import's tables as its last release leaves them (files carry document_id; file_chunks is gone unless `old`). */
const IMPORT_SCHEMA = (old) => `
	CREATE SCHEMA mod_downloads;
	CREATE TABLE mod_downloads.files (
		id bigint PRIMARY KEY, name text NOT NULL, content_type text NOT NULL DEFAULT '', size_bytes bigint NOT NULL, sha256 text,
		status text NOT NULL DEFAULT 'uploading', source_url text NOT NULL DEFAULT '', note text NOT NULL DEFAULT '', received_by text NOT NULL,
		received_at timestamptz NOT NULL DEFAULT now(), sent_to text NOT NULL DEFAULT '', sent_link text NOT NULL DEFAULT '', sent_by text, sent_at timestamptz,
		updated_at timestamptz NOT NULL DEFAULT now(), sent_file_id bigint, origin text NOT NULL DEFAULT '', origin_detail text NOT NULL DEFAULT '',
		mail_features text[], mail_trained boolean NOT NULL DEFAULT false, storage_path text${old ? "" : ", document_id bigint, document_added_here boolean NOT NULL DEFAULT false, account_code text NOT NULL DEFAULT '', mail_folder text NOT NULL DEFAULT '', mail_uid text NOT NULL DEFAULT ''"});
	${old ? "CREATE TABLE mod_downloads.file_chunks (file_id bigint, chunk_index integer, data bytea);" : ""}
	CREATE TABLE mod_downloads.extractions (
		id bigint PRIMARY KEY, file_id bigint NOT NULL, status text NOT NULL, model text NOT NULL DEFAULT '', currency text NOT NULL DEFAULT '', instructions text NOT NULL DEFAULT '',
		transactions jsonb NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), decided_by text, decided_at timestamptz, csv_file_id bigint);
	CREATE TABLE mod_downloads.mail_seen (folder text, uidvalidity bigint, uid text, outcome text NOT NULL, files integer NOT NULL DEFAULT 0, subject text NOT NULL DEFAULT '',
		mail_from text NOT NULL DEFAULT '', seen_at timestamptz NOT NULL DEFAULT now(), reason text NOT NULL DEFAULT '', mail_date timestamptz, PRIMARY KEY (folder, uidvalidity, uid));
	CREATE TABLE mod_downloads.mail_training (id bigint PRIMARY KEY, label smallint NOT NULL, features text[] NOT NULL, sender text NOT NULL DEFAULT '', subject text NOT NULL DEFAULT '',
		file_name text NOT NULL DEFAULT '', source text NOT NULL DEFAULT 'delete', created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
	CREATE TABLE mod_downloads.email_check_state (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());`;

function module(db) {
	const routes = new Map();
	const documents = fakeDocuments();
	const settings = {};
	const dashboard = [];
	const ctx = {
		id: "categorizer", name: "Auto sort", schema: "mod_categorizer", HttpError,
		route: (method, p, fn) => routes.set(`${method} ${p}`, fn),
		log: { info() {}, warn() {}, error() {} },
		settings: { get: async () => ({ ...settings }), set: async (v) => void Object.assign(settings, v) },
		dashboard: { todo: async (t) => dashboard.push(["todo", t.key, t.title]), remove: async (k) => dashboard.push(["remove", k]) },
		orgs: { forEach: async (fn) => fn({ id: 1 }) },
		documents: documents.api, storage: fakeStorage().api,
	};
	const T = (t) => `mod_categorizer.${t}`;
	const bad = (m) => new HttpError(422, m);
	const adoption = registerAdoption(ctx, { q: db.q, T, bad, files: moduleFiles(ctx, { q: db.q, T }) });
	const call = (route, body, role = "admin") => routes.get(route)({ body, user: { username: "alex", role }, query: new URLSearchParams() });
	return { adoption, call, documents, settings, dashboard };
}

test("the Import module's data is taken over when an admin says so: rows only, once, nothing deleted", async (t) => {
	const db = await scratch();
	if (!db) return t.skip("no PostgreSQL (or no Ledger checkout with the pg driver) to run this against");
	try {
		const M = module(db);
		await new Promise((r) => setTimeout(r, 50));
		// Import was never installed here: nothing waits, nothing to do, and email isn't held.
		let st = await M.call("GET /adoption");
		assert.deepEqual({ installed: st.installed, pending: st.pending, hold: st.hold }, { installed: false, pending: false, hold: false });
		assert.equal(await M.adoption.mailHold(), "");
		await assert.rejects(M.call("POST /adoption", { confirm: true }), { status: 409 });

		// Import's data, after its last release: every file a document, one whose file was lost.
		await db.q(IMPORT_SCHEMA(false));
		const d1 = M.documents.put({ kind: "invoice", filename: "hydro.pdf", data: Buffer.from("%PDF-1.4 hydro"), source: "downloads" });
		const d2 = M.documents.put({ kind: "statement", filename: "statement.pdf", data: Buffer.from("%PDF-1.4 statement"), source: "downloads" });
		const d3 = M.documents.put({ kind: "other", filename: "statement-extracted.csv", data: Buffer.from("Date,Description,Amount\n"), source: "downloads" });
		await db.q(
			`INSERT INTO mod_downloads.files (id, name, content_type, size_bytes, sha256, status, note, received_by, origin, origin_detail, mail_features, mail_folder, mail_uid, document_id, document_added_here, sent_to, sent_link, sent_by, sent_at, account_code) VALUES
			 (11, 'hydro.pdf', 'application/pdf', 14, 'aa', 'new', 'Email from Hydro: "Your bill"', 'email', 'email', 'Hydro One', '{from:bills@hydro.example,ext:pdf}', 'imap:me@example.com', 'm-1', $1, true, '', '', NULL, NULL, ''),
			 (12, 'statement.pdf', 'application/pdf', 18, 'bb', 'sent', '', 'pat', 'upload', '', NULL, '', '', $2, true, 'extracted to statement-extracted.csv', '/apps/downloads?file=13', 'pat', now(), ''),
			 (13, 'statement-extracted.csv', 'text/csv', 24, 'cc', 'new', 'Extracted by AI', 'pat', '', '', NULL, '', '', $3, true, '', '', NULL, NULL, ''),
			 (14, 'lost.pdf', 'application/pdf', 5, 'dd', 'archived', '', 'pat', 'app', 'Pixel 8', NULL, '', '', NULL, false, '', '', NULL, NULL, '6100'),
			 (15, 'half.pdf', 'application/pdf', 5, NULL, 'uploading', '', 'pat', '', '', NULL, '', '', NULL, false, '', '', NULL, NULL, '')`,
			[d1, d2, d3],
		);
		await db.q(`INSERT INTO mod_downloads.extractions (id, file_id, status, model, currency, transactions, created_by, decided_by, decided_at, csv_file_id) VALUES
			(3, 12, 'approved', 'm', 'CAD', '[{"date":"2026-10-01","description":"METRO","amount":"-45.10","balance":""}]', 'pat', 'pat', now(), 13),
			(4, 11, 'rejected', 'm', '', '[{"date":"2026-10-02","description":"X","amount":"1.00","balance":""}]', 'pat', 'pat', now(), NULL)`);
		await db.q(`INSERT INTO mod_downloads.mail_seen (folder, uidvalidity, uid, outcome, files, subject, mail_from, reason) VALUES ('imap:me@example.com', 0, 'm-1', 'files', 1, 'Your bill', 'bills@hydro.example', ''), ('imap:me@example.com', 0, 'm-2', 'learned_skip', 0, 'Deals', 'deals@shop.example', 'flyer.pdf: like 3 files you deleted')`);
		await db.q(`INSERT INTO mod_downloads.mail_training (id, label, features, sender, subject, file_name, source, created_by) VALUES (7, -1, '{from:deals@shop.example,ext:pdf}', 'Shop', 'Deals', 'flyer.pdf', 'delete', 'pat')`);
		await db.q(`INSERT INTO mod_downloads.email_check_state (key, value) VALUES ('mail', '{"last_check_at":"2026-11-01T10:00:00.000Z"}')`);
		await db.q(`INSERT INTO public.module_settings (module_id, "values") VALUES ('downloads', '{"keep_days": 30, "mail_source": "imap", "mail_keywords": "invoice, facture", "something_else": 1}')`);

		st = await M.call("GET /adoption", undefined, "bookkeeper");
		assert.deepEqual({ installed: st.installed, old: st.old_version, ready: st.ready, waiting: st.waiting, extractions: st.extractions, seen: st.mail_seen, training: st.training, settings: st.has_settings, pending: st.pending, hold: st.hold, admin: st.admin },
			{ installed: true, old: false, ready: 3, waiting: 1, extractions: 2, seen: 2, training: 1, settings: true, pending: true, hold: true, admin: false });
		assert.match(await M.adoption.mailHold(), /haven't been taken over yet/);

		// It moves a person's data between modules: an admin, and an explicit yes.
		await assert.rejects(M.call("POST /adoption", { confirm: true }, "bookkeeper"), { status: 403 });
		await assert.rejects(M.call("POST /adoption", {}), { status: 422 });
		await assert.rejects(M.call("POST /adoption", undefined), { status: 422 });
		assert.equal((await db.q(`SELECT count(*)::int AS n FROM mod_categorizer.inbox_files`)).rows[0].n, 0);

		const { adopted } = await M.call("POST /adoption", { confirm: true });
		assert.deepEqual({ ...adopted, settings: [...adopted.settings].sort() }, { files: 3, extractions: 2, extractions_saved: 1, mail_seen: 2, mail_training: 1, settings: ["keep_days", "mail_keywords", "mail_source"], waiting: 1, linked: 0 });
		const { rows: inbox } = await db.q(`SELECT id, name, status, document_id, document_added_here, origin, origin_detail, mail_uid, mail_features, sent_to, sent_link, adopted_from FROM mod_categorizer.inbox_files ORDER BY adopted_from`);
		assert.deepEqual(inbox.map((r) => [r.adopted_from, r.name, r.status, Number(r.document_id), r.document_added_here]), [[11n, "hydro.pdf", "new", d1, false], [12n, "statement.pdf", "sent", d2, false], [13n, "statement-extracted.csv", "new", d3, false]]);
		assert.deepEqual([inbox[0].origin, inbox[0].origin_detail, inbox[0].mail_uid, inbox[0].mail_features], ["email", "Hydro One", "m-1", ["from:bills@hydro.example", "ext:pdf"]]);
		// A link into Import's page points at the same file here.
		assert.equal(inbox[1].sent_link, `/apps/categorizer?file=${inbox[2].id}`);
		// What the AI read comes along with its file; what a person approved there is kept with the original document.
		const { rows: ex } = await db.q(`SELECT file_id, status, csv_file_id, adopted_from FROM mod_categorizer.inbox_extractions ORDER BY adopted_from`);
		assert.deepEqual(ex.map((e) => [e.adopted_from, e.file_id, e.status, e.csv_file_id]), [[3n, inbox[1].id, "approved", inbox[2].id], [4n, inbox[0].id, "rejected", null]]);
		assert.deepEqual(M.documents.extractions.get(d2).data.transactions, [{ date: "2026-10-01", description: "METRO", amount_cents: -4510 }]);
		assert.equal(M.documents.extractions.has(d1), false, "a rejected reading is not kept with the document");
		// The email log and what was learned: the next email check here looks at neither message again.
		assert.deepEqual((await db.q(`SELECT uid, outcome, reason FROM mod_categorizer.mail_seen ORDER BY uid`)).rows.map((r) => [r.uid, r.outcome]), [["m-1", "files"], ["m-2", "learned_skip"]]);
		assert.equal((await db.q(`SELECT count(*)::int AS n FROM mod_categorizer.mail_training WHERE adopted_from = 7 AND label = -1`)).rows[0].n, 1);
		assert.equal((await db.q(`SELECT value->>'last_check_at' AS at FROM mod_categorizer.module_state WHERE key = 'mail'`)).rows[0].at, "2026-11-01T10:00:00.000Z");
		// Settings that exist here, an old choice mapped to today's.
		assert.deepEqual(M.settings, { keep_days: 30, mail_source: "mail", mail_keywords: "invoice, facture" });
		// No file was copied, filed or removed: rows only.
		assert.deepEqual(M.documents.calls.filter((c) => ["add", "remove"].includes(c[0])), []);
		assert.equal(M.documents.docs.size, 3);

		// The email check is let go; what couldn't come (the lost file) is still reported.
		st = await M.call("GET /adoption");
		assert.deepEqual({ ready: st.ready, waiting: st.waiting, pending: st.pending, hold: st.hold, files: st.adopted.files }, { ready: 0, waiting: 1, pending: false, hold: false, files: 3 });
		assert.equal(await M.adoption.mailHold(), "");
		assert.ok(M.dashboard.some((d) => d[0] === "remove" && d[1] === "import-adoption"));

		// Again: nothing is taken twice, and settings changed here since are left alone.
		M.settings.keep_days = 90;
		const again = (await M.call("POST /adoption", { confirm: true })).adopted;
		assert.deepEqual(again, { files: 0, extractions: 0, extractions_saved: 0, mail_seen: 0, mail_training: 0, settings: [], waiting: 1, linked: 0 });
		assert.equal(M.settings.keep_days, 90);
		assert.equal((await db.q(`SELECT count(*)::int AS n FROM mod_categorizer.inbox_files`)).rows[0].n, 3);
		// Import's last release finds the lost file after all: only that one comes over.
		const d4 = M.documents.put({ kind: "receipt", filename: "lost.pdf", data: Buffer.from("%PDF-1.4 found"), source: "downloads" });
		await db.q(`UPDATE mod_downloads.files SET document_id = $1 WHERE id = 14`, [d4]);
		assert.equal((await M.call("GET /adoption")).pending, true);
		const later = (await M.call("POST /adoption", { confirm: true })).adopted;
		assert.deepEqual([later.files, later.waiting], [1, 0]);
		const { rows: phone } = await db.q(`SELECT status, origin, origin_detail, account_code FROM mod_categorizer.inbox_files WHERE adopted_from = 14`);
		assert.deepEqual(phone, [{ status: "archived", origin: "app", origin_detail: "Pixel 8", account_code: "6100" }]);
		assert.equal((await M.call("GET /adoption")).adopted.files, 4);
		// A file deleted from the inbox here stays deleted: it isn't Import's waiting to be taken over again.
		await db.q(`DELETE FROM mod_categorizer.inbox_extractions WHERE file_id IN (SELECT id FROM mod_categorizer.inbox_files WHERE adopted_from = 11)`);
		await db.q(`DELETE FROM mod_categorizer.inbox_files WHERE adopted_from = 11`);
		const after = await M.call("GET /adoption");
		assert.deepEqual([after.ready, after.extractions, after.pending], [0, 0, false]);
		assert.equal((await M.call("POST /adoption", { confirm: true })).adopted.files, 0);
		assert.equal((await db.q(`SELECT count(*)::int AS n FROM mod_categorizer.inbox_files WHERE adopted_from = 11`)).rows[0].n, 0);
		// And for a hand-over made before taken ids were kept (0.17.0): what was deleted since is not offered again either.
		await db.q(`DELETE FROM mod_categorizer.inbox_files WHERE adopted_from = 12`);
		await db.q(`DELETE FROM mod_categorizer.adopted_ids`);
		await db.q(`UPDATE mod_categorizer.module_state SET value = value - 'taken_seeded' WHERE key = 'import_adoption'`);
		const old = await M.call("GET /adoption");
		assert.deepEqual([old.ready, old.pending], [0, false]);
		// Never deleted from, never changed: Import's tables are as they were.
		const { rows: left } = await db.q(`SELECT (SELECT count(*) FROM mod_downloads.files)::int AS files, (SELECT count(*) FROM mod_downloads.extractions)::int AS extractions, (SELECT count(*) FROM mod_downloads.mail_seen)::int AS seen, (SELECT count(*) FROM mod_downloads.mail_training)::int AS training, (SELECT sent_link FROM mod_downloads.files WHERE id = 12) AS link`);
		assert.deepEqual(left[0], { files: 5, extractions: 2, seen: 2, training: 1, link: "/apps/downloads?file=13" });
	} finally {
		await db.end();
	}
});

test("an Import that wasn't updated to its last release: its files wait, email is held, and an admin can decline", async (t) => {
	const db = await scratch();
	if (!db) return t.skip("no PostgreSQL (or no Ledger checkout with the pg driver) to run this against");
	try {
		const M = module(db);
		// An old Import: bytes still in file_chunks, no document_id column at all.
		await db.q(IMPORT_SCHEMA(true));
		await db.q(`INSERT INTO mod_downloads.files (id, name, size_bytes, status, received_by) VALUES (1, 'a.pdf', 5, 'new', 'pat'), (2, 'b.csv', 5, 'sent', 'pat')`);
		await db.q(`INSERT INTO mod_downloads.mail_seen (folder, uidvalidity, uid, outcome) VALUES ('gmail:me@example.com', 0, 'x1', 'files')`);
		let st = await M.call("GET /adoption");
		assert.deepEqual({ old: st.old_version, ready: st.ready, waiting: st.waiting, pending: st.pending, hold: st.hold }, { old: true, ready: 0, waiting: 2, pending: true, hold: true });
		await new Promise((r) => setTimeout(r, 50));
		// Taking over now brings what can come (the email log) and says what waits: no failure, no file rows.
		const { adopted } = await M.call("POST /adoption", { confirm: true });
		assert.deepEqual([adopted.files, adopted.mail_seen, adopted.waiting], [0, 1, 2]);
		assert.equal((await db.q(`SELECT count(*)::int AS n FROM mod_categorizer.inbox_files`)).rows[0].n, 0);

		// Declining: the notice goes and the email check no longer waits; it can be offered again.
		const db2 = await scratch();
		try {
			const N = module(db2);
			await db2.q(IMPORT_SCHEMA(true));
			await db2.q(`INSERT INTO mod_downloads.files (id, name, size_bytes, status, received_by) VALUES (1, 'a.pdf', 5, 'new', 'pat')`);
			assert.match(await N.adoption.mailHold(), /update Import to its last version/);
			await assert.rejects(N.call("POST /adoption/dismiss", { dismissed: true }, "bookkeeper"), { status: 403 });
			await assert.rejects(N.call("POST /adoption/dismiss", {}), { status: 422 });
			st = await N.call("POST /adoption/dismiss", { dismissed: true });
			assert.deepEqual([st.pending, st.hold, st.dismissed], [false, false, true]);
			assert.equal(await N.adoption.mailHold(), "");
			st = await N.call("POST /adoption/dismiss", { dismissed: false });
			assert.equal(st.pending, true);
		} finally {
			await db2.end();
		}
	} finally {
		await db.end();
	}
});

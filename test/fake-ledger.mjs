// A stand-in for Ledger's ctx, for route tests: Ledger's Documents (the one file store, with tags and
// extracted data) as an in-memory list, the old module storage as a map whose put() answers 410 as
// it does for a module built for Ledger 0.27.0, and the database answering from [pattern, answer]
// pairs (anything else finds nothing), so each test states the rows it needs.

import { createHash } from "node:crypto";
import register from "../server.mjs";

export class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

/**
 * ctx.ledger.moveLine as Ledger 0.32.0 has it: moves one line of a posted entry to another account
 * of the same currency and returns the entry; the move is logged on it (entry.moves). Refused for a
 * line ticked on a reconciliation (a line with `reconciled: true` here) and for an entry that was
 * reversed or is a reversal (409); for no such line or account, another currency, or the account
 * the line is already in (422). entries: Map id -> entry (lines numbered from 1, or by
 * line_number); accounts: () => the chart. calls: every move asked for.
 */
export function fakeMoveLine(entries, accounts, calls = []) {
	return async (entryId, lineNumber, accountCode, opts = {}, user) => {
		calls.push([Number(entryId), Number(lineNumber), String(accountCode), opts?.reason ?? ""]);
		const e = entries.get(Number(entryId));
		if (!e) throw new HttpError(404, "not found");
		const line = (e.lines ?? []).find((l, i) => Number(l.line_number ?? i + 1) === Number(lineNumber));
		if (!line) throw new HttpError(422, `entry ${entryId} has no line ${lineNumber}`);
		if (line.account_code === accountCode) throw new HttpError(422, "nothing was changed");
		if (e.reverses_id != null) throw new HttpError(409, `entry ${entryId} is a reversal; its accounts follow the entry it reverses`);
		if (e.reversed_by_id != null) throw new HttpError(409, `entry ${entryId} was reversed by entry ${e.reversed_by_id}; its accounts can't change any more`);
		const chart = accounts();
		const to = chart.find((a) => a.code === accountCode);
		const from = chart.find((a) => a.code === line.account_code);
		if (!to) throw new HttpError(422, `account ${JSON.stringify(accountCode)} does not exist`);
		if (from && to.currency !== from.currency) throw new HttpError(422, `must be a ${from.currency} account, like the line`);
		if (to.is_active === false) throw new HttpError(422, "that account is inactive");
		if (line.reconciled) throw new HttpError(409, `line ${lineNumber} is ticked on the reconciliation to 2026-03-31; undo that reconciliation before changing its account`);
		e.moves = [...(e.moves ?? []), { line: Number(lineNumber), from: line.account_code, to: accountCode, reason: opts?.reason ?? "", by: user?.username ?? null }];
		line.account_code = accountCode;
		return e;
	};
}

/** Ledger's Documents: add / ensure / get / read / update / remove / url, tags, extracted data. */
export function fakeDocuments(self = "categorizer") {
	const docs = new Map(); // id -> { id, kind, filename, data, source, ... }
	const tags = new Map(); // id -> [{ tag, note, module_id, set_by }]
	const extractions = new Map(); // id -> { data, text, module_id }
	const tagListeners = [];
	const calls = [];
	let next = 30;
	const must = (id) => {
		const d = docs.get(Number(id));
		if (!d) throw new HttpError(404, "no such document");
		return d;
	};
	const info = (d) => ({
		id: d.id, kind: d.kind, origin: d.origin, source: d.source, title: d.title ?? d.filename, filename: d.filename, content_type: d.content_type ?? "", size_bytes: d.data.length,
		account_code: d.account_code ?? null, account_name: null, reconciled: false, note: d.note ?? "", url: `/api/v1/documents/${d.id}/file`,
		tags: [...(tags.get(d.id) ?? [])],
		extracted: extractions.has(d.id) ? { module_id: extractions.get(d.id).module_id, keys: Object.keys(extractions.get(d.id).data), has_text: false, url: `/api/v1/documents/${d.id}/extracted` } : null,
	});
	const announce = (c) => {
		for (const fn of tagListeners) fn({ ...c });
	};
	const add = (d, _user, opts) => {
		calls.push(["add", d.filename, opts ?? null]);
		const sha = createHash("sha256").update(d.data).digest("hex");
		const dup = [...docs.values()].find((x) => x.sha === sha);
		if (dup) throw Object.assign(new HttpError(409, `this file is already here as "${dup.filename}" (document ${dup.id})`), { document_id: dup.id });
		const doc = { ...d, id: ++next, sha, source: self, origin: d.origin ?? "created" };
		docs.set(doc.id, doc);
		return info(doc);
	};
	const api = {
		maxBytes: 100 << 20,
		add: async (d, user, opts) => add(d, user, opts),
		ensure: async (d, user, opts) => {
			try {
				return { document: add(d, user, opts), added: true };
			} catch (err) {
				if (err.status !== 409) throw err;
				return { document: info(must(err.document_id)), added: false };
			}
		},
		get: async (id) => info(must(id)),
		read: async (id) => must(id).data,
		update: async (id, change) => (calls.push(["update", Number(id), change]), Object.assign(must(id), change), info(must(id))),
		remove: async (id) => {
			if (must(id).source !== self) throw new HttpError(403, "a module can only delete documents it added itself");
			calls.push(["remove", Number(id)]);
			docs.delete(Number(id));
		},
		url: (id) => `/api/v1/documents/${id}/file`,
		onAdded() {},
		extracted: async (id) => {
			must(id);
			const x = extractions.get(Number(id));
			return x ? { document_id: Number(id), data: structuredClone(x.data), text: x.text ?? null, module_id: x.module_id, keys: Object.keys(x.data) } : null;
		},
		setExtracted: async (id, x) => {
			must(id);
			calls.push(["setExtracted", Number(id), Object.keys(x.data ?? {})]);
			// Through JSON, as Ledger does: bigint cents become numbers, null keys are removed.
			const given = JSON.parse(JSON.stringify(x.data ?? {}, (_k, v) => (typeof v === "bigint" ? Number(v) : v)));
			const data = { ...(x.replace ? {} : (extractions.get(Number(id))?.data ?? {})), ...given };
			for (const k of Object.keys(data)) if (data[k] === null) delete data[k];
			const first = !extractions.has(Number(id));
			extractions.set(Number(id), { data, text: x.text ?? extractions.get(Number(id))?.text ?? null, module_id: self });
			if (first) tags.set(Number(id), [...(tags.get(Number(id)) ?? []), { tag: "extracted", note: "", module_id: self, set_by: null }]);
			return api.extracted(id);
		},
		clearExtracted: async (id) => extractions.delete(Number(id)),
		tags: {
			standard: ["extracted", "posted", "paid", "billed", "overdue"],
			of: async (id) => (must(id), [...(tags.get(Number(id)) ?? [])]),
			set: async (id, tag, opts = {}, user) => {
				must(id);
				if (tag === "extracted") throw new HttpError(422, '"extracted" is set by saving what was read from the file');
				const list = (tags.get(Number(id)) ?? []).filter((t) => t.tag !== tag && !(tag === "paid" && t.tag === "overdue"));
				list.push({ tag, note: opts.note ?? "", module_id: self, set_by: user?.username ?? null });
				tags.set(Number(id), list);
				calls.push(["tag", Number(id), tag, opts.note ?? ""]);
				return list;
			},
			remove: async (id, tag) => {
				must(id);
				calls.push(["untag", Number(id), tag]);
				tags.set(Number(id), (tags.get(Number(id)) ?? []).filter((t) => t.tag !== tag));
				return tags.get(Number(id));
			},
			onChange: (fn) => tagListeners.push(fn),
		},
	};
	return {
		api, docs, tags, extractions, calls,
		/** A person (or another module) sets or removes a tag, as on Ledger's Documents page. */
		async outside(id, action, tag, { module_id = null, set_by = "sam" } = {}) {
			const list = (tags.get(Number(id)) ?? []).filter((t) => t.tag !== tag);
			if (action === "set") list.push({ tag, note: "", module_id, set_by });
			tags.set(Number(id), list);
			for (const fn of tagListeners) await fn({ document_id: Number(id), action, tag, module_id });
		},
		/** A document someone else filed. */
		put(d) {
			const doc = { origin: "imported", ...d, id: ++next, sha: createHash("sha256").update(d.data).digest("hex"), source: d.source ?? "user" };
			docs.set(doc.id, doc);
			return doc.id;
		},
		announce,
	};
}

/** The module's old storage: readable and removable, but put() answers 410 (Ledger 0.27.0). */
export function fakeStorage(initial = {}) {
	const stored = new Map(Object.entries(initial));
	const calls = [];
	return {
		stored, calls,
		api: {
			put: async (p) => {
				calls.push(["put", p]);
				throw new HttpError(410, "storage.put: modules keep no files of their own since Ledger 0.27.0");
			},
			get: async (p) => (stored.has(p) ? { path: p, data: stored.get(p), size: stored.get(p).length } : null),
			stat: async (p) => (stored.has(p) ? { path: p, size: stored.get(p).length } : null),
			list: async () => [...stored.keys()].map((p) => ({ path: p, size: stored.get(p).length })),
			remove: async (p) => (calls.push(["remove", p]), stored.delete(p)),
			url: (p) => `/api/v1/modules/categorizer/storage/${p}`,
		},
	};
}

/**
 * Registers the whole module on a fake ctx. answers: [[RegExp, (sql, params) => rows | { rows, rowCount }]].
 * → { call(route, { params, body, query, user }), ctx, documents, storage, sql, dashboard }
 */
export async function start({ answers = [], ledger = {}, llm = {}, documents = fakeDocuments(), storage = fakeStorage(), settings = {}, files = {} } = {}) {
	const routes = new Map();
	const dashboard = [];
	const sql = [];
	const none = { rows: [], rowCount: 0 };
	const ctx = {
		id: "categorizer",
		name: "Auto sort",
		version: "0.0.0",
		ledgerVersion: "0.27.0",
		schema: "mod_categorizer",
		HttpError,
		response: (status, body) => ({ status, body }),
		log: { info() {}, warn() {}, error() {} },
		route: (method, path, handler) => routes.set(`${method} ${path}`, handler),
		db: {
			async query(text, params = []) {
				sql.push({ text, params });
				for (const [pattern, answer] of answers) {
					if (!pattern.test(text)) continue;
					const r = await answer(text, params);
					return Array.isArray(r) ? { rows: r, rowCount: r.length } : (r ?? none);
				}
				return none;
			},
		},
		settings: { get: async () => ({ ...settings }), set: async (v) => void Object.assign(settings, v), onChange() {} },
		llm: { status: async () => ({ configured: false, allowed: false }), json: async () => { throw new HttpError(409, "not set up"); }, ...llm },
		ledger: { listAccounts: async () => [], ...ledger },
		dashboard: Object.fromEntries(["notify", "todo", "complete", "remove"].map((name) => [name, async (...args) => dashboard.push([name, ...args])])),
		orgs: { forEach: async (fn) => fn({ id: 1 }), current: async () => ({ id: 1, name: "Main", kind: "business" }), list: async () => [] },
		files: { onReceive() {}, inbox: async () => [], outbox: async () => [], targets: () => [], ...files },
		mail: { status: async () => ({ connected: false, kind: null, account: null, canRead: false, canSend: false }) },
		search: { provide() {} },
		documents: documents.api,
		storage: storage.api,
	};
	await register(ctx);
	// Startup work that isn't awaited (moving old files, clean-up) settles before the test goes on.
	await new Promise((r) => setTimeout(r, 20));
	const call = (route, { params = {}, body, query = "", user = { username: "pat", role: "bookkeeper" } } = {}) => {
		const handler = routes.get(route);
		if (!handler) throw new Error(`no route ${route}`);
		return handler({ params, body, query: new URLSearchParams(query), user });
	};
	return { call, ctx, documents, storage, sql, dashboard, routes };
}

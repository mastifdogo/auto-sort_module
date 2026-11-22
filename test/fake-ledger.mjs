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

/**
 * The three tags Ledger keeps on an entry that is paid by linked payments (0.33.0): setting one
 * takes the other two off, and "paid" takes "overdue" off too.
 */
export const TAG_CLEARS = { paid: ["overdue", "partially_paid", "unpaid"], partially_paid: ["paid", "unpaid"], unpaid: ["paid", "partially_paid"] };

/**
 * ctx.ledger.linkPayment / unlinkPayment / payments as Ledger 0.33.0 has them. A link says entry
 * `payment` pays entry `bill`, amount_cents of it (left out: the payment's whole total). Neither
 * entry changes. What an entry is owed (due_cents) is its lines in a customer's or vendor's own
 * account, else in accounts receivable or payable, else its total; a reversed payment is listed
 * with counted false. After every change Ledger sets exactly one of unpaid / partially_paid / paid
 * on the entry paid, in the name of whoever made the change (setTag(by, entryId, tag)); "unpaid"
 * when its last payment is taken off. entries: Map id -> entry; accounts: () => the chart.
 * → { api: { linkPayment, unlinkPayment, payments }, links, calls, reversed(paymentId), unlinked(bill, payment) }
 */
export function fakePayments(entries, { accounts = () => [], setTag = async () => {}, self = "categorizer" } = {}) {
	const links = []; // { bill, payment, amount, note, by }
	const calls = [];
	const big = (v) => BigInt(String(v ?? 0));
	const debits = (e) => (e?.lines ?? []).reduce((s, l) => s + big(l.debit_cents), 0n);
	const due = (e) => {
		const chart = new Map(accounts().map((a) => [a.code, a]));
		const lines = e?.lines ?? [];
		const own = lines.filter((l) => chart.get(l.account_code)?.entity);
		const control = lines.filter((l) => ["receivable", "payable"].includes(chart.get(l.account_code)?.kind));
		const pick = own.length ? own : control;
		const net = pick.reduce((s, l) => s + big(l.debit_cents) - big(l.credit_cents), 0n);
		return net !== 0n ? (net < 0n ? -net : net) : debits(e);
	};
	const of = (billId) => {
		const mine = links.filter((l) => l.bill === Number(billId));
		if (mine.length === 0) return null;
		const payments = mine
			.map((l) => {
				const p = entries.get(l.payment);
				return { entry_id: l.payment, entry_date: p?.entry_date ?? "", description: p?.description ?? "", amount_cents: l.amount ?? debits(p), counted: p?.reversed_by_id == null && p?.reverses_id == null, note: l.note };
			})
			.sort((a, b) => (a.entry_date < b.entry_date ? -1 : a.entry_date > b.entry_date ? 1 : a.entry_id - b.entry_id));
		const owed = due(entries.get(Number(billId)));
		const paid = payments.filter((p) => p.counted).reduce((s, p) => s + p.amount_cents, 0n);
		return { currency: "CAD", due_cents: owed, paid_cents: paid, left_cents: paid >= owed ? 0n : owed - paid, status: paid <= 0n ? "unpaid" : paid >= owed ? "paid" : "partially_paid", payments };
	};
	const sync = async (billId, by, left = false) => {
		const p = of(billId);
		if (!p && !left) return;
		await setTag(by, billId, p?.status ?? "unpaid");
	};
	const unlink = async (billId, paymentId, by) => {
		const i = links.findIndex((l) => l.bill === Number(billId) && l.payment === Number(paymentId));
		if (i < 0) return false;
		links.splice(i, 1);
		await sync(Number(billId), by, true);
		return true;
	};
	return {
		links,
		calls,
		api: {
			linkPayment: async (billId, paymentId, opts = {}, user) => {
				calls.push(["link", Number(billId), Number(paymentId), opts.amount_cents === undefined || opts.amount_cents === null ? null : big(opts.amount_cents), opts.note ?? "", user?.username ?? null]);
				if (Number(billId) === Number(paymentId)) throw new HttpError(422, "an entry can't be linked to itself");
				if (!entries.has(Number(billId))) throw new HttpError(404, "not found");
				if (!entries.has(Number(paymentId))) throw new HttpError(422, `there is no entry ${paymentId}`);
				const amount = opts.amount_cents === undefined || opts.amount_cents === null ? null : big(opts.amount_cents);
				if (amount !== null && amount <= 0n) throw new HttpError(422, "amount_cents must be more than zero");
				const had = links.find((l) => l.bill === Number(billId) && l.payment === Number(paymentId));
				if (had) Object.assign(had, { amount, note: opts.note ?? "" });
				else links.push({ bill: Number(billId), payment: Number(paymentId), amount, note: opts.note ?? "", by: self });
				await sync(Number(billId), self);
				return of(billId);
			},
			unlinkPayment: async (billId, paymentId) => {
				calls.push(["unlink", Number(billId), Number(paymentId)]);
				return unlink(billId, paymentId, self);
			},
			payments: async (entryId) => of(entryId),
		},
		of,
		/** A person reversed a payment's entry in Ledger: it stops counting for the entries it pays. */
		async reversed(paymentId, reversalId = Number(paymentId) + 1000) {
			const p = entries.get(Number(paymentId));
			if (p) p.reversed_by_id = reversalId;
			for (const l of links.filter((x) => x.payment === Number(paymentId))) await sync(l.bill, null);
		},
		/** A person took a payment off an entry on its page in Ledger. */
		unlinked: (billId, paymentId) => unlink(billId, paymentId, null),
		/** A person (or another module) linked a payment in Ledger. */
		async linked(billId, paymentId, amount = null, by = null) {
			links.push({ bill: Number(billId), payment: Number(paymentId), amount: amount === null ? null : big(amount), note: "", by });
			await sync(Number(billId), by);
		},
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

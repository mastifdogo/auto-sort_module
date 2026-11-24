// Ledger's shared tags on journal entries (ctx.tags, Ledger 0.23.0): what Auto sort sets on a
// bill's entry, what it does when someone else tags that entry, and rows that pay tagged entries.
// The routes run against a stand-in ctx whose `tags` keeps them in memory, like Ledger's.

import assert from "node:assert/strict";
import { test } from "node:test";
import register from "../server.mjs";
import { assignPayables, payableCandidates } from "../lib/tags.mjs";
import { TAG_CLEARS, fakeMoveLine, fakePayments } from "./fake-ledger.mjs";

class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

/**
 * Ledger 0.31.0's books, for the tags and the postings below: every vendor has an account of their
 * own under accounts payable and every customer one under accounts receivable, made when first
 * needed. accounts: the chart (the same list ctx.ledger.listAccounts answers with); entries: the
 * journal (the Map the stand-in ctx posts into).
 */
function fakeBooks(accounts, entries = new Map()) {
	const KIND = { vendor: "payable", customer: "receivable" };
	const own = (entityId, role, currency = "CAD", under = null) => {
		const have = accounts.find((a) => a.entity?.id === Number(entityId) && a.entity.role === role && a.currency === currency);
		if (have) return have;
		const parent = accounts.find((a) => (under ? a.code === under : a.kind === KIND[role] && a.currency === currency));
		if (!parent) throw new HttpError(422, `no accounts ${KIND[role]} in ${currency}`);
		const a = { code: `${parent.code}-${entityId}`, name: `Entity ${entityId}`, type: parent.type, currency, is_active: true, kind: null, parent_code: parent.code, entity: { id: Number(entityId), name: `Entity ${entityId}`, role } };
		accounts.push(a);
		return a;
	};
	const account = (code) => accounts.find((a) => a.code === code);
	return {
		accounts,
		entries,
		own,
		account,
		/**
		 * What Ledger does to an entry posted with a customer or vendor: its receivable or payable lines go
		 * to their own account. An entry that already has a line in that account is one between it and
		 * accounts receivable or payable: it is posted as written.
		 */
		route: (entry) =>
			!entry.entity_id ? entry.lines : entry.lines.map((l) => {
				const a = account(l.account_code);
				const role = a && !a.entity ? Object.keys(KIND).find((r) => KIND[r] === a.kind) : null;
				const written = role && entry.lines.some((x) => account(x.account_code)?.entity?.id === Number(entry.entity_id) && account(x.account_code).entity.role === role);
				return role && !written ? { ...l, account_code: own(entry.entity_id, role, a.currency, a.code).code } : l;
			}),
		/** The tags read from the accounts: a line in a customer's or vendor's own account says whose the entry is. */
		derived: (entryId) => {
			const out = [];
			for (const l of entries.get(Number(entryId))?.lines ?? []) {
				const e = account(l.account_code)?.entity;
				if (e && !out.some((t) => t.tag === e.role && t.entity.id === e.id)) out.push({ id: 0, tag: e.role, entity: { id: e.id, name: e.name }, note: "", module_id: null, set_by: null, account_code: l.account_code });
			}
			return out;
		},
		/** Tagged "vendor": the entry's lines in accounts payable move to the vendor's account. → { moved, tracked } */
		claim: (entryId, role, entityId) => {
			const e = entries.get(Number(entryId));
			let moved = 0;
			for (const l of e?.lines ?? []) {
				const a = account(l.account_code);
				if (!a || a.entity || a.kind !== KIND[role]) continue;
				l.account_code = own(entityId, role, a.currency, a.code).code;
				moved++;
			}
			return { moved, tracked: (e?.lines ?? []).some((l) => account(l.account_code)?.entity?.id === Number(entityId) && account(l.account_code).entity.role === role) };
		},
		/** The tag taken off: the lines go back to accounts payable. → whose lines moved */
		release: (entryId, role, entityId = null) => {
			const freed = new Set();
			for (const l of entries.get(Number(entryId))?.lines ?? []) {
				const a = account(l.account_code);
				if (a?.entity?.role !== role || (entityId && a.entity.id !== Number(entityId))) continue;
				l.account_code = a.parent_code;
				freed.add(a.entity.id);
			}
			return [...freed];
		},
		owed: (entityId) => {
			let n = 0n;
			for (const e of entries.values()) for (const l of e.lines ?? []) if (account(l.account_code)?.entity?.id === Number(entityId)) n += BigInt(l.credit_cents) - BigInt(l.debit_cents);
			return n;
		},
	};
}

/**
 * ctx.tags as Ledger has it: tags per entry, "paid" takes "overdue" off, listeners hear every
 * change (after it is done, as Ledger tells them). Of "unpaid", "partially_paid" and "paid" an entry
 * carries one: setting one takes the other two off (Ledger 0.33.0). With books (Ledger 0.31.0): "customer" and "vendor" are read from the accounts, setting
 * one moves the entry's receivable or payable line and stores nothing, removing one moves it back.
 */
function fakeTags(entries = new Map(), books = null) {
	const byEntry = new Map();
	const listeners = [];
	const log = [];
	const stored = (id) => byEntry.get(Number(id)) ?? [];
	const list = (id) => {
		const out = stored(id).map((t) => ({ ...t }));
		for (const d of books?.derived(id) ?? []) {
			const kept = out.find((t) => t.tag === d.tag && t.entity?.id === d.entity.id);
			if (kept) kept.account_code = d.account_code;
			else out.push(d);
		}
		return out;
	};
	const announce = async (c) => {
		log.push(c);
		for (const fn of listeners) await fn(c);
	};
	/** by: a module id, or null for a person. */
	async function setAs(by, entryId, tag, opts = {}, user) {
		const id = Number(entryId);
		const entity_id = opts.entity_id ?? null;
		if ((tag === "customer" || tag === "vendor") && !entity_id) throw new HttpError(422, "entity_id is required");
		if (books && entity_id && (tag === "customer" || tag === "vendor")) {
			const { moved, tracked } = books.claim(id, tag, entity_id);
			if (tracked) {
				byEntry.set(id, stored(id).filter((t) => !(t.tag === tag && t.entity?.id === entity_id)));
				if (moved > 0) await announce({ entry_id: id, action: "set", tag, entity_id, module_id: by });
				return list(id);
			}
		}
		if (stored(id).some((t) => t.tag === tag && (t.entity?.id ?? null) === entity_id)) return list(id);
		const cleared = (TAG_CLEARS[tag] ?? []).filter((other) => stored(id).some((t) => t.tag === other));
		byEntry.set(id, [...stored(id).filter((t) => !cleared.includes(t.tag)), { tag, entity: entity_id ? { id: entity_id, name: `Entity ${entity_id}` } : null, note: opts.note ?? "", module_id: by, set_by: user?.username ?? null }]);
		await announce({ entry_id: id, action: "set", tag, entity_id, module_id: by });
		for (const other of cleared) await announce({ entry_id: id, action: "removed", tag: other, entity_id: null, module_id: by });
		return list(id);
	}
	async function removeAs(by, entryId, tag, opts = {}) {
		const id = Number(entryId);
		const gone = stored(id).filter((t) => t.tag === tag && (!opts.entity_id || t.entity?.id === opts.entity_id));
		byEntry.set(id, stored(id).filter((t) => !gone.includes(t)));
		for (const g of gone) await announce({ entry_id: id, action: "removed", tag, entity_id: g.entity?.id ?? null, module_id: by });
		if (books && (tag === "customer" || tag === "vendor")) for (const who of books.release(id, tag, opts.entity_id ?? null)) await announce({ entry_id: id, action: "removed", tag, entity_id: who, module_id: by });
		return list(id);
	}
	return {
		api: {
			standard: ["paid", "partially_paid", "unpaid", "billed", "overdue", "customer", "vendor"],
			set: (entryId, tag, opts, user) => setAs("categorizer", entryId, tag, opts, user),
			remove: (entryId, tag, opts) => removeAs("categorizer", entryId, tag, opts),
			of: async (entryId) => list(entryId),
			entries: async ({ tag }) => [...entries.values()].map((e) => ({ ...e, tags: list(e.id) })).filter((e) => e.tags.some((t) => t.tag === tag)),
			onChange: (fn) => listeners.push(fn),
		},
		setAs,
		removeAs,
		names: (entryId) => list(entryId).map((t) => (t.entity ? `${t.tag}:${t.entity.id}` : t.tag)).sort(),
		/** Only what is kept as a tag (not what is read from an account). */
		kept: (entryId) => stored(entryId).map((t) => (t.entity ? `${t.tag}:${t.entity.id}` : t.tag)).sort(),
		list,
		log,
	};
}

/** One bill kept in memory: answers the queries the bill routes and lib/tags.mjs make about it. */
function billTable(bill) {
	const assign = (sql, params) => {
		const set = /SET ([\s\S]*?) WHERE /.exec(sql)[1];
		for (const part of set.split(/,\s*(?![^(]*\))/)) {
			const m = /^\s*(\w+) = (.+?)\s*$/s.exec(part);
			if (!m) continue;
			const [, col, v] = m;
			if (/^\$\d+$/.test(v)) bill[col] = params[Number(v.slice(1)) - 1];
			else if (v === "NULL") bill[col] = null;
			else if (v === "true" || v === "false") bill[col] = v === "true";
			else if (/^'.*'$/.test(v)) bill[col] = v.slice(1, -1);
			else if (v === "now()") bill[col] = new Date();
		}
	};
	return [
		[/SELECT vendor, customer_name FROM mod_categorizer\.bills/, () => []],
		[/SELECT body_text FROM mod_categorizer\.bills/, () => [{ body_text: "" }]],
		[/FROM mod_categorizer\.bills b LEFT JOIN mod_categorizer\.bill_documents d ON d\.bill_id = b\.id WHERE b\.id = \$1/, () => [{ ...bill }]],
		[/FROM mod_categorizer\.bills WHERE journal_entry_id = \$1 OR/, (_, [entry]) => (String(bill.journal_entry_id ?? bill.paid_entry_id) === String(entry) ? [{ ...bill }] : [])],
		[/FROM mod_categorizer\.bills WHERE tags_synced_at IS NULL/, () => (bill.tags_synced_at || (bill.journal_entry_id ?? bill.paid_entry_id) == null ? [] : [{ ...bill }])],
		[/UPDATE mod_categorizer\.bills SET status = 'paid', paid_at = now\(\), paid_by_tag = true/, (sql, params) => {
			if (!["new", "open"].includes(bill.status)) return { rows: [], rowCount: 0 };
			assign(sql, params);
			return { rows: [], rowCount: 1 };
		}],
		[/UPDATE mod_categorizer\.bills b SET status = 'paid', paid_entry_id = \$3/, (_, [, code, entry]) => {
			if (!["new", "open"].includes(bill.status) || (bill.ap_account ?? bill.account_code) !== code) return [];
			Object.assign(bill, { status: "paid", paid_entry_id: entry, paid_by_tag: false });
			return [{ id: bill.id }];
		}],
		[/UPDATE mod_categorizer\.bills SET/, (sql, params) => {
			if (/AND status = 'paid'/.test(sql) && bill.status !== "paid") return { rows: [], rowCount: 0 };
			if (/AND vendor_entity_id IS NULL/.test(sql)) {
				if (bill.vendor_entity_id !== null) return { rows: [], rowCount: 0 };
				Object.assign(bill, { vendor_entity_id: params[1], vendor: bill.vendor || params[2] });
				return { rows: [], rowCount: 1 };
			}
			assign(sql, params);
			return { rows: [], rowCount: 1 };
		}],
	];
}

const ACCOUNTS = [
	{ code: "1000", name: "Chequing", type: "asset", currency: "CAD", is_active: true },
	{ code: "1200", name: "Accounts receivable", type: "asset", currency: "CAD", is_active: true },
	{ code: "2000", name: "Accounts payable", type: "liability", currency: "CAD", is_active: true },
	{ code: "4000", name: "Sales", type: "revenue", currency: "CAD", is_active: true },
	{ code: "5100", name: "Utilities", type: "expense", currency: "CAD", is_active: true },
];
// Auto sort's own clearing account for bills made from statements (hidden, like every clearing account).
const CLEARING = { code: "2990", name: "Statement bills to clear", type: "liability", currency: "CAD", is_active: true, kind: "clearing", hidden: true, module_id: "categorizer" };
const ACCOUNT_MAP = new Map(ACCOUNTS.map((a) => [a.code, a]));

/** Registers the module on a fake ctx with tags (or without: tags null, an older Ledger). */
/** books: Ledger 0.31.0's own accounts for customers and vendors (fakeBooks); without, an older Ledger. */
/** moveLine: Ledger 0.32.0, which can move a posted line (ctx.ledger.moveLine); moves: every move asked for. */
/** payments: Ledger 0.33.0's linked payments (fakePayments over the same journal and tags): ctx.ledger.linkPayment, unlinkPayment, payments. */
async function start({ answers = [], tags = fakeTags(), entries = new Map(), settings = {}, accounts = ACCOUNTS, books = null, entities = {}, moveLine = false, moves = [], payments = null, root = null } = {}) {
	const routes = new Map();
	const posted = [];
	const related = [];
	const reversed = [];
	const none = { rows: [], rowCount: 0 };
	const ctx = {
		id: "categorizer",
		name: "Auto sort",
		version: "0.0.0",
		ledgerVersion: "0.23.0",
		schema: "mod_categorizer",
		HttpError,
		response: (status, body) => ({ status, body }),
		log: { info() {}, warn() {}, error() {} },
		route: (method, path, handler) => routes.set(`${method} ${path}`, handler),
		db: {
			async query(sql, params = []) {
				for (const [pattern, answer] of answers) {
					if (!pattern.test(sql)) continue;
					const r = await answer(sql, params);
					return Array.isArray(r) ? { rows: r, rowCount: r.length } : (r ?? none);
				}
				return none;
			},
		},
		settings: { get: async () => settings, set: async () => {}, onChange() {} },
		llm: { status: async () => ({ configured: false }), json: async () => { throw new HttpError(409, "not set up"); } },
		ledger: {
			listAccounts: async () => accounts,
			createJournalEntry: async (entry) => {
				const e = { ...entry, lines: (books ? books.route(entry) : entry.lines).map((l, i) => ({ ...l, line_number: i + 1 })), id: 100 + posted.length, entity: entry.entity_id ? { id: entry.entity_id, name: "" } : null, reversed_by_id: null, reverses_id: null, links: [{ module_id: "categorizer" }], sent_links: entry.links ?? [] };
				posted.push(e);
				entries.set(e.id, e);
				return e;
			},
			getJournalEntry: async (id) => {
				if (!entries.has(Number(id))) throw new HttpError(404, "not found");
				return { ...entries.get(Number(id)), tags: tags ? tags.list(id) : undefined };
			},
							reverseJournalEntry: async (id) => {
					reversed.push(Number(id));
					// With linked payments the journal is kept true: the entry is reversed, and stops counting as a payment.
					if (payments) await payments.reversed(id);
					return { id: Number(id) + 1000 };
				},
			linkJournalEntry: async () => ({}),
			unlinkJournalEntry: async () => true,
			clearingAccount: async ({ key, currency }) => ({ ...CLEARING, module_key: key, currency }),
							relateEntries: async (a, b, opts) => { related.push([Number(a), Number(b), opts.note]); return []; },
				unrelateEntries: async (a, b) => {
					const i = related.findIndex((r) => (r[0] === Number(a) && r[1] === Number(b)) || (r[0] === Number(b) && r[1] === Number(a)));
					if (i >= 0) related.splice(i, 1);
					return i >= 0;
				},
				...(payments ? payments.api : {}),
			...(moveLine ? { moveLine: fakeMoveLine(entries, () => accounts, moves) } : {}),
		},
		dashboard: Object.fromEntries(["notify", "todo", "complete", "remove"].map((call) => [call, async () => {}])),
		orgs: { forEach: async (fn) => fn({ id: 1 }), current: async () => ({ id: 1, name: "Main", kind: "business" }), list: async () => [] },
		files: { onReceive() {}, inbox: async () => [] },
		search: { provide() {} },
		...(tags ? { tags: tags.api } : {}),
		// Root mode (Ledger 0.21.1): what the root routes change goes through ctx.root.
		...(root ? { root } : {}),
		// Ledger's list of customers and vendors, with their own accounts on Ledger 0.31.0.
		...(books ? { entities: { find: async () => null, list: async () => [], ensure: async (name) => ({ id: entities[name] ?? 99, name }), account: async (id, role, currency) => books.own(id, role, currency) } } : {}),
	};
	await register(ctx);
			// The startup backfill isn't awaited by register.
		await new Promise((r) => setImmediate(r));
		if (payments) await new Promise((r) => setTimeout(r, 15));
	const call = (route, { params = {}, body, query = "", user = { username: "pat", role: "bookkeeper" } } = {}) =>
		routes.get(route)({ params, body, query: new URLSearchParams(query), user });
			return { call, posted, tags, entries, related, reversed, payments };
}

const BILL = { id: 3n, kind: "bill", status: "new", vendor: "Hydro One", invoice_number: "H-1", bill_date: "2026-03-01", due_date: "2026-03-20", amount_cents: 8550n, currency: "CAD", account_code: "5100", ap_account: null, journal_entry_id: null, paid_entry_id: null, vendor_entity_id: 7, paid_by_tag: false, paid_tag_by: null, tags_synced_at: null };

test("approving a bill into payables tags its entry with the vendor, and overdue when it is past due", async () => {
	const bill = { ...BILL };
	const { call, posted, tags } = await start({ answers: billTable(bill), settings: { ap_account: "2000" } });
	await call("POST /bills/:id/approve", { params: { id: "3" } });
	assert.equal(posted.length, 1);
	assert.equal(bill.status, "open");
	assert.deepEqual(tags.names(posted[0].id), ["overdue", "vendor:7"]);
	// A bill not due yet isn't overdue.
	const later = { ...BILL, due_date: "2999-01-01" };
	const b = await start({ answers: billTable(later), settings: { ap_account: "2000" } });
	await b.call("POST /bills/:id/approve", { params: { id: "3" } });
	assert.deepEqual(b.tags.names(b.posted[0].id), ["vendor:7"]);
});

test("bills and receipts go to accounts payable: the account set, else the one Ledger tagged; with neither they are only tracked", async () => {
	const credit = (e) => e.lines.find((l) => BigInt(l.credit_cents) > 0n).account_code;
	// A receipt is posted to payables like a bill.
	const receipt = { ...BILL, kind: "receipt", due_date: null };
	const a = await start({ answers: billTable(receipt), settings: { ap_account: "2000" } });
	await a.call("POST /bills/:id/approve", { params: { id: "3" } });
	assert.equal(a.posted.length, 1);
	assert.equal(credit(a.posted[0]), "2000");
	assert.match(a.posted[0].description, /receipt/);
	// No account set: the one tagged "Accounts payable" in the bill's currency.
	const tagged = [...ACCOUNTS, { code: "2010", name: "Trade creditors", type: "liability", currency: "CAD", is_active: true, kind: "payable" }, { code: "2020", name: "US payables", type: "liability", currency: "USD", is_active: true, kind: "payable" }];
	const b = await start({ answers: billTable({ ...BILL, due_date: "2999-01-01" }), accounts: tagged });
	await b.call("POST /bills/:id/approve", { params: { id: "3" } });
	assert.equal(credit(b.posted[0]), "2010");
	// Neither: nothing is posted, the bill is tracked.
	const lone = { ...BILL };
	const c = await start({ answers: billTable(lone) });
	await c.call("POST /bills/:id/approve", { params: { id: "3" } });
	assert.equal(c.posted.length, 0);
	assert.equal(lone.status, "open");
});

test("Create bill on a statement, on a Ledger that can't move a line (before 0.32.0): Dr Auto sort's clearing account / Cr accounts payable, as before", async () => {
	const bill = { ...BILL, status: "new", vendor: "", invoice_number: null, bill_date: null, due_date: null, amount_cents: null, account_code: null, vendor_entity_id: 7, statement_id: 9n };
	const statementAnswers = [
		[/SELECT id FROM mod_categorizer\.statements WHERE id = \$1/, () => [{ id: 9n }]],
		[/SELECT id FROM mod_categorizer\.bills WHERE statement_id = \$1/, () => []],
		[/INSERT INTO mod_categorizer\.bills \(source, vendor, updated_by, statement_id\)/, (_, [source, vendor]) => { Object.assign(bill, { source, vendor }); return [{ id: 3n }]; }],
	];
	const body = { kind: "bill", statement_id: "9", currency: "CAD", vendor: "Visa", bill_date: "2026-03-01", due_date: "2999-01-01", amount: "850.00" };
	const { call, posted } = await start({ answers: [...statementAnswers, ...billTable(bill)], settings: { ap_account: "2000" }, accounts: [...ACCOUNTS, CLEARING] });
	const r = await call("POST /bills", { body });
	assert.equal(r.status, 201);
	assert.equal(posted.length, 1);
	assert.deepEqual(posted[0].lines.map((l) => [l.account_code, String(l.debit_cents), String(l.credit_cents)]), [["2990", "85000", "0"], ["2000", "0", "85000"]]);
	assert.deepEqual([bill.status, bill.source, bill.account_code, bill.ap_account, bill.journal_entry_id], ["open", "statement", "2990", "2000", 100]);
	// Without an accounts payable account nothing is created; without an amount neither.
	const none = await start({ answers: [...statementAnswers, ...billTable({ ...bill })], accounts: [...ACCOUNTS, CLEARING] });
	await assert.rejects(none.call("POST /bills", { body }), (e) => e.status === 409 && /accounts payable/.test(e.message));
	assert.equal(none.posted.length, 0);
	const blank = await start({ answers: [...statementAnswers, ...billTable({ ...bill })], settings: { ap_account: "2000" }, accounts: [...ACCOUNTS, CLEARING] });
	await assert.rejects(blank.call("POST /bills", { body: { ...body, amount: null } }), (e) => e.status === 422 || e.status === 400);
});

test("Mark paid tags the bill's entry paid (and no longer overdue); Reopen takes it off", async () => {
	const bill = { ...BILL, status: "open", journal_entry_id: 50, ap_account: "2000" };
	const tags = fakeTags();
	await tags.setAs("categorizer", 50, "overdue");
	const { call, posted } = await start({ answers: billTable(bill), tags, entries: new Map([[50, { id: 50, lines: [] }]]) });
	await call("PATCH /bills/:id", { params: { id: "3" }, body: { status: "paid" } });
	assert.deepEqual(tags.names(50), ["paid", "vendor:7"]);
	await call("PATCH /bills/:id", { params: { id: "3" }, body: { status: "new" } });
	assert.deepEqual(tags.names(50), ["vendor:7"]);
	assert.equal(posted.length, 0);
});

test("undoing the approval takes the status tags off the reversed entry", async () => {
	const bill = { ...BILL, status: "open", journal_entry_id: 50, ap_account: "2000" };
	const tags = fakeTags();
	await tags.setAs("categorizer", 50, "overdue");
	await tags.setAs("categorizer", 50, "vendor", { entity_id: 7 });
	const { call } = await start({ answers: billTable(bill), tags, entries: new Map([[50, { id: 50, lines: [] }]]) });
	await call("POST /bills/:id/unapprove", { params: { id: "3" } });
	assert.deepEqual(tags.names(50), ["vendor:7"]);
	assert.equal(bill.journal_entry_id, null);
});

test("paid set on a bill's entry by a person or another module makes the bill paid without posting; taking it off reopens it", async () => {
	const bill = { ...BILL, status: "open", journal_entry_id: 50, ap_account: "2000" };
	const tags = fakeTags();
	const { call, posted } = await start({ answers: billTable(bill), tags, entries: new Map([[50, { id: 50, lines: [] }]]) });
	await tags.setAs(null, 50, "paid", {}, { username: "sam" });
	assert.equal(bill.status, "paid");
	assert.equal(bill.paid_by_tag, true);
	assert.equal(bill.paid_tag_by, "sam");
	assert.equal(posted.length, 0, "nothing is posted in reaction to a tag");
	const shown = await call("GET /bills/:id", { params: { id: "3" } });
	assert.equal(shown.bill.paid_by_tag, true);
	await tags.removeAs("payments", 50, "paid");
	assert.equal(bill.status, "open");
	assert.equal(bill.paid_by_tag, false);
	// Another module this time.
	await tags.setAs("payments", 50, "paid");
	assert.equal(bill.paid_tag_by, "module payments");
	assert.equal(posted.length, 0);
});

test("the module's own tag changes aren't acted on, and a paid bill with its payment in the journal keeps the tag", async () => {
	const bill = { ...BILL, status: "paid", journal_entry_id: 50, paid_entry_id: 60, ap_account: "2000" };
	const tags = fakeTags();
	await tags.setAs("categorizer", 50, "paid");
	await start({ answers: billTable(bill), tags, entries: new Map([[50, { id: 50, lines: [] }]]) });
	await tags.removeAs("categorizer", 50, "paid");
	assert.equal(bill.status, "paid", "its own removal isn't a signal");
	await tags.setAs("categorizer", 50, "paid");
	await tags.removeAs(null, 50, "paid");
	assert.equal(bill.status, "paid", "the payment is in the journal: still paid");
	assert.deepEqual(tags.list(50).filter((t) => t.tag === "paid").map((t) => [t.note, t.module_id]), [["payment in entry #60", "categorizer"]]);
});

test("a vendor tagged on the entry of a bill without one fills the bill's vendor", async () => {
	const bill = { ...BILL, status: "open", vendor: "", vendor_entity_id: null, journal_entry_id: 50, ap_account: "2000" };
	const tags = fakeTags();
	await start({ answers: billTable(bill), tags, entries: new Map([[50, { id: 50, lines: [] }]]) });
	await tags.setAs(null, 50, "vendor", { entity_id: 9 });
	assert.equal(String(bill.vendor_entity_id), "9");
	assert.equal(bill.vendor, "Entity 9");
	await tags.setAs(null, 50, "vendor", { entity_id: 12 });
	assert.equal(String(bill.vendor_entity_id), "9", "a bill that has a vendor keeps it");
});

test("bills approved before tags existed get theirs at startup, once", async () => {
	const bill = { ...BILL, status: "paid", journal_entry_id: 50, paid_entry_id: 60, ap_account: "2000" };
	const tags = fakeTags();
	const entries = new Map([[50, { id: 50, lines: [] }]]);
	await start({ answers: billTable(bill), tags, entries });
	assert.deepEqual(tags.names(50), ["paid", "vendor:7"]);
	assert.ok(bill.tags_synced_at);
	const changes = tags.log.length;
	await start({ answers: billTable(bill), tags, entries });
	assert.equal(tags.log.length, changes, "a second start changes nothing");
});

test("a bill's entry tagged paid while the module wasn't listening is caught at the backfill", async () => {
	const bill = { ...BILL, status: "open", journal_entry_id: 50, ap_account: "2000" };
	const tags = fakeTags();
	await tags.setAs(null, 50, "paid", {}, { username: "sam" });
	await start({ answers: billTable(bill), tags, entries: new Map([[50, { id: 50, lines: [] }]]) });
	assert.equal(bill.status, "paid");
	assert.equal(bill.paid_by_tag, true);
	assert.deepEqual(tags.names(50), ["paid", "vendor:7"]);
});

test("without ctx.tags (an older Ledger) bills work as before", async () => {
	const bill = { ...BILL };
	const { call, posted } = await start({ answers: billTable(bill), tags: null, settings: { ap_account: "2000" } });
	await call("POST /bills/:id/approve", { params: { id: "3" } });
	assert.equal(posted.length, 1);
	assert.equal(bill.status, "open");
	await call("PATCH /bills/:id", { params: { id: "3" }, body: { status: "paid" } });
	assert.equal(bill.status, "paid");
	assert.deepEqual(await call("POST /sort-now"), { bill_matches: 0, transfer_links: 0, journal_matches: 0, tag_matches: 0 });
});

// ---------------------------------------------------------------------------
// Rows that pay what another module tagged as owed
// ---------------------------------------------------------------------------

const invoice = (id, cents, tags, extra = {}) => ({
	id,
	entry_date: "2026-03-01",
	description: `Invoice ${id}`,
	reference: `INV-${id}`,
	reverses_id: null,
	reversed_by_id: null,
	entity: null,
	links: [{ module_id: "sales" }],
	lines: [{ account_code: "1200", debit_cents: cents, credit_cents: 0n }, { account_code: "4000", debit_cents: 0n, credit_cents: cents }],
	tags: tags.map((t) => (typeof t === "string" ? { tag: t, entity: null } : t)),
	...extra,
});
const ACME = { tag: "customer", entity: { id: 4, name: "Acme Corp" } };

test("payableCandidates: a deposit pays an entry tagged billed and not paid, on its receivable line", () => {
	const row = { id: 1n, account_code: "1000", date: "2026-03-15", description: "E-TRANSFER ACME CORP", amount_cents: 50000n };
	const entries = [
		invoice(10, 50000n, ["billed", ACME]),
		invoice(11, 50000n, ["billed", "paid", ACME]),
		invoice(12, 50000n, []),
		invoice(13, 70000n, ["billed"]),
		invoice(14, 50000n, ["billed"], { reversed_by_id: 99 }),
		invoice(15, 50000n, ["billed"], { links: [{ module_id: "categorizer" }] }),
		invoice(16, 50000n, ["overdue", { tag: "customer", entity: { id: 5, name: "Globex" } }]),
	];
	const found = payableCandidates(row, entries, ACCOUNT_MAP, "categorizer");
	assert.deepEqual(found.map((c) => [c.entry_id, c.account_code, c.named, c.overdue]), [[10, "1200", true, false], [16, "1200", false, true]]);
	assert.equal(found[0].who.id, 4);
	// A payment going out doesn't pay an invoice; it pays an entry tagged for a vendor that credits a payable.
	const out = { ...row, amount_cents: -50000n, description: "HYDRO ONE" };
	assert.deepEqual(payableCandidates(out, entries, ACCOUNT_MAP, "categorizer"), []);
	const owed = { ...invoice(20, 50000n, [{ tag: "vendor", entity: { id: 7, name: "Hydro One" } }]), lines: [{ account_code: "5100", debit_cents: 50000n, credit_cents: 0n }, { account_code: "2000", debit_cents: 0n, credit_cents: 50000n }] };
	assert.deepEqual(payableCandidates(out, [owed], ACCOUNT_MAP, "categorizer").map((c) => [c.entry_id, c.account_code, c.role, c.named]), [[20, "2000", "vendor", true]]);
});

test("assignPayables: an unnamed match is only offered when nothing else has that amount", () => {
	const row = (id, description) => ({ id, account_code: "1000", date: "2026-03-15", description, amount_cents: 50000n });
	const two = [invoice(10, 50000n, ["billed"]), invoice(11, 50000n, ["billed"])];
	assert.deepEqual(assignPayables([row(1n, "DEPOSIT")], two, ACCOUNT_MAP, "categorizer"), []);
	assert.deepEqual(assignPayables([row(1n, "DEPOSIT")], [two[0]], ACCOUNT_MAP, "categorizer").map((p) => p.candidate.entry_id), [10]);
	const named = [invoice(10, 50000n, ["billed"]), invoice(11, 50000n, ["billed", ACME])];
	assert.deepEqual(assignPayables([row(1n, "ACME CORP PAYMENT")], named, ACCOUNT_MAP, "categorizer").map((p) => p.candidate.entry_id), [11]);
	assert.deepEqual(assignPayables([row(1n, "ACME CORP PAYMENT")], named, ACCOUNT_MAP, "categorizer", (r, c) => c.entry_id !== 11).map((p) => p.candidate.entry_id), [10], "the rejected one isn't offered again");
});

/** One statement row kept in memory, for Sort now and posting. */
function rowTable(row) {
	return [
		[/FROM mod_categorizer\.statements s LEFT JOIN mod_categorizer\.transactions t/, () => [{ id: 1n, filename: "march.csv", account_code: "1000", posted: 0 }]],
		[/count\(\*\)::int AS n FROM mod_categorizer\.match_suggestions/, () => [{ n: 0 }]],
		[/pays_entry_id, rejected_pays_entry_id FROM mod_categorizer\.transactions/, () => (row.status === "new" ? [{ ...row }] : [])],
		[/SET pays_entry_id = \$2, suggested_code = \$3/, (_, [, entry, code, confidence, reason]) => {
			Object.assign(row, { pays_entry_id: entry, suggested_code: code, confidence, reason, source: "tag" });
			return { rows: [], rowCount: 1 };
		}],
		[/SELECT id FROM mod_categorizer\.transactions\s+WHERE statement_id = \$1 AND status = 'new'/, () => (row.status === "new" && (row.chosen_code ?? row.suggested_code) ? [{ id: row.id }] : [])],
		[/SET status = 'posting' WHERE id = \$1 AND status = 'new'/, () => {
			row.status = "posting";
			return [{ date: row.date, description: row.description, memo: "", amount_cents: row.amount_cents, fitid: "", account_code: row.account_code, code: row.chosen_code ?? row.suggested_code, bill_id: null, statement_id: 1n, transfer_tx_id: null, transfer_entry_id: null, pays_entry_id: row.pays_entry_id }];
		}],
		[/SET status = 'posted', journal_entry_id = \$2/, (_, [, entry]) => { Object.assign(row, { status: "posted", journal_entry_id: entry }); }],
		[/SET pays_entry_id = NULL WHERE id = \$1/, () => { row.pays_entry_id = null; }],
		[/INSERT INTO mod_categorizer\.rules/, () => { row.learned = true; }],
	];
}
const ROW = { id: 7n, statement_id: 1n, account_code: "1000", date: "2026-03-15", description: "E-TRANSFER ACME CORP", amount_cents: 50000n, status: "new", pays_entry_id: null, rejected_pays_entry_id: null, chosen_code: null, suggested_code: null };

test("a deposit is offered the billed entry it pays; only a person posting it tags that entry paid", async () => {
	const row = { ...ROW };
	const tags = fakeTags(new Map([[10, invoice(10, 50000n, [])]]));
	await tags.setAs("sales", 10, "billed");
	await tags.setAs("sales", 10, "customer", { entity_id: 4 });
	const entries = new Map([[10, invoice(10, 50000n, [])]]);
	const { call, posted, related } = await start({ answers: rowTable(row), tags, entries });
	assert.equal((await call("POST /sort-now")).tag_matches, 1);
	assert.equal(String(row.pays_entry_id), "10");
	assert.equal(row.suggested_code, "1200");
	assert.deepEqual(tags.names(10), ["billed", "customer:4"], "matching alone tags nothing");
	assert.deepEqual(await call("POST /statements/:id/post", { params: { id: "1" }, body: {} }), { posted: 1, already_recorded: 0, failed: [] });
	assert.deepEqual(posted[0].lines.map((l) => [l.account_code, l.debit_cents, l.credit_cents]), [["1000", 50000n, 0n], ["1200", 0n, 50000n]]);
	assert.deepEqual(tags.names(10), ["billed", "customer:4", "paid"]);
	assert.equal(tags.list(10).find((t) => t.tag === "paid").set_by, "pat");
	assert.deepEqual(tags.names(posted[0].id), ["customer:4"], "the payment's entry says who it is from");
	assert.equal(row.learned, undefined, "paying an invoice isn't a payee rule");
	assert.deepEqual(related, [[posted[0].id, 10, "payment of entry #10"]], "the payment's entry is linked to the entry it pays");
});

test("a row booked to another account than the tagged entry's doesn't mark it paid", async () => {
	const row = { ...ROW, pays_entry_id: 10, suggested_code: "1200", chosen_code: "4000" };
	const tags = fakeTags();
	await tags.setAs("sales", 10, "billed");
	const { call, posted, related } = await start({ answers: rowTable(row), tags, entries: new Map([[10, invoice(10, 50000n, [])]]) });
	await call("POST /statements/:id/post", { params: { id: "1" }, body: {} });
	assert.equal(posted.length, 1);
	assert.deepEqual(tags.names(10), ["billed"]);
	assert.deepEqual(related, []);
	assert.equal(row.pays_entry_id, null);
});

test("posting a bill's payment tags the bill's payable entry paid, with a note naming the payment", async () => {
	const bill = { ...BILL, status: "open", journal_entry_id: 50, ap_account: "2000" };
	const row = { ...ROW, description: "HYDRO ONE", amount_cents: -8550n, suggested_code: "2000" };
	const tags = fakeTags();
	await tags.setAs("categorizer", 50, "overdue");
	// The row is linked to the bill and its posted payments cover it.
	const answers = [[/SELECT b\.id, b\.amount_cents FROM/, () => [{ id: 3n, amount_cents: 8550n }]], [/AS linked,/, () => [{ linked: "8550", posted: "8550" }]], ...rowTable(row), ...billTable(bill)];
	// The claimed row is the bill's payment.
	const claim = answers.find(([p]) => p.source.includes("SET status = 'posting'"));
	const original = claim[1];
	claim[1] = () => original().map((r) => ({ ...r, bill_id: 3n }));
	const { call, posted } = await start({ answers, tags, entries: new Map([[50, { id: 50, lines: [] }]]) });
	await call("POST /statements/:id/post", { params: { id: "1" }, body: {} });
	assert.equal(bill.status, "paid");
	assert.deepEqual(tags.names(50), ["paid", "vendor:7"]);
	assert.equal(tags.list(50).find((t) => t.tag === "paid").note, `payment in entry #${posted[0].id}`);
	assert.deepEqual(tags.names(posted[0].id), [], "the payment was posted with the vendor: no tag needed");
});

// ---------------------------------------------------------------------------
// Vendors' and customers' own accounts (Ledger 0.31.0)
// ---------------------------------------------------------------------------

// Ledger 0.30.0 tags accounts receivable and payable; 0.31.0 keeps each customer's and vendor's own account under them.
const TAGGED = () => ACCOUNTS.map((a) => ({ ...a, kind: a.code === "2000" ? "payable" : a.code === "1200" ? "receivable" : null, parent_code: null, entity: null }));
const shape = (e) => e.lines.map((l) => [l.account_code, String(l.debit_cents), String(l.credit_cents)]);
const vendorChanges = (tags) => tags.log.filter((c) => c.tag === "vendor" || c.tag === "customer");

/** Ledger 0.31.0: the chart, the journal and the tags that read "vendor" from the accounts. */
function ownBooks(accounts = TAGGED()) {
	const books = fakeBooks(accounts);
	return { books, tags: fakeTags(books.entries, books), entries: books.entries, accounts };
}
/** A bill's payable entry as Ledger keeps it, with its payable line in `code`. */
const payableEntry = (id, code, extra = {}) => ({ id, entry_date: "2026-03-01", description: "Hydro One", reversed_by_id: null, reverses_id: null, links: [{ module_id: "categorizer" }], lines: [{ account_code: "5100", debit_cents: 8550n, credit_cents: 0n }, { account_code: code, debit_cents: 0n, credit_cents: 8550n }], ...extra });
/** The bill is among the ones the to-do refresh syncs (Sort now, every hour, after each change). */
const refreshed = (bill) => [[/b\.paid_entry_id, b\.vendor_entity_id, b\.tags_synced_at,/, () => [{ ...bill, document_id: null, matched: false }]]];
/** The claimed row is the payment of bill 3, and its posted payments cover the bill. */
function billPayment(row, bill) {
	const answers = [[/SELECT b\.id, b\.amount_cents FROM/, () => [{ id: 3n, amount_cents: 8550n }]], [/AS linked,/, () => [{ linked: "8550", posted: "8550" }]], [/SELECT vendor, vendor_entity_id FROM mod_categorizer\.bills/, () => [{ vendor: bill.vendor, vendor_entity_id: bill.vendor_entity_id }]], ...rowTable(row), ...billTable(bill)];
	const claim = answers.find(([p]) => p.source.includes("SET status = 'posting'"));
	const original = claim[1];
	claim[1] = () => original().map((r) => ({ ...r, bill_id: 3n }));
	return answers;
}

test("vendor accounts: an approved bill is posted to its vendor's own account, with no vendor tag; its payment clears that account", async () => {
	const bill = { ...BILL, due_date: "2999-01-01" };
	const row = { ...ROW, description: "HYDRO ONE", amount_cents: -8550n, suggested_code: "2000" };
	const o = ownBooks();
	const { call, posted } = await start({ answers: billPayment(row, bill), ...o });
	await call("POST /bills/:id/approve", { params: { id: "3" } });
	assert.deepEqual(shape(posted[0]), [["5100", "8550", "0"], ["2000-7", "0", "8550"]], "Ledger posts the payable line to the vendor's account");
	assert.equal(posted[0].entity_id, 7);
	assert.equal(bill.ap_account, "2000", "the bill keeps the account it went through");
	assert.deepEqual(o.tags.kept(posted[0].id), [], "no vendor tag is kept: the account says whose it is");
	assert.deepEqual(vendorChanges(o.tags), [], "and none was asked for");
	assert.deepEqual(o.tags.names(posted[0].id), ["vendor:7"], "Ledger still reads it as the vendor's");
	assert.equal(o.books.owed(7), 8550n);
	// The page is told where the line sits.
	const shown = await call("GET /bills/:id", { params: { id: "3" } });
	assert.deepEqual(shown.bill.payable_account, { code: "2000-7", name: "Entity 7", own: true });
	// The payment row is offered accounts payable and posted to the vendor's account.
	await call("POST /statements/:id/post", { params: { id: "1" }, body: {} });
	assert.deepEqual(shape(posted[1]), [["1000", "0", "8550"], ["2000-7", "8550", "0"]]);
	assert.equal(bill.status, "paid");
	assert.equal(o.books.owed(7), 0n, "nothing is owed to the vendor any more");
	assert.deepEqual(o.tags.kept(posted[1].id), [], "the payment needs no vendor tag either");
	assert.deepEqual(o.tags.kept(posted[0].id), ["paid"]);
	assert.equal(row.learned, undefined, "a bill payment isn't a payee rule");
});

test("vendor accounts: an account chosen under Settings that isn't tagged payable keeps the bill itself, tagged as before", async () => {
	const bill = { ...BILL, due_date: "2999-01-01" };
	const accounts = [...TAGGED(), { code: "2100", name: "Trade creditors", type: "liability", currency: "CAD", is_active: true, kind: null, parent_code: null, entity: null }];
	const o = ownBooks(accounts);
	const row = { ...ROW, description: "HYDRO ONE", amount_cents: -8550n, suggested_code: "2100" };
	const { call, posted } = await start({ answers: billPayment(row, bill), settings: { ap_account: "2100" }, ...o });
	await call("POST /bills/:id/approve", { params: { id: "3" } });
	assert.deepEqual(shape(posted[0]), [["5100", "8550", "0"], ["2100", "0", "8550"]]);
	assert.deepEqual(o.tags.kept(posted[0].id), ["vendor:7"], "no account says whose it is: the tag does");
	assert.equal((await call("GET /status")).payables.kept_in_chosen, true);
	await call("POST /statements/:id/post", { params: { id: "1" }, body: {} });
	assert.deepEqual(shape(posted[1]), [["1000", "0", "8550"], ["2100", "8550", "0"]]);
	assert.equal(bill.status, "paid");
	assert.equal(accounts.some((a) => a.entity), false, "no vendor account was made");
	// A vendor's own account can't be the payables account for every bill.
	const own = ownBooks();
	own.books.own(7, "vendor");
	const refused = await start({ answers: billTable({ ...BILL }), settings: { ap_account: "2000-7" }, ...own });
	await assert.rejects(refused.call("POST /bills/:id/approve", { params: { id: "3" } }), (e) => e.status === 409 && /own account/.test(e.message));
});

test("vendor accounts: after Ledger moved a bill's line into the vendor's account and dropped the tag, nothing loops and everything still works", async () => {
	// What Ledger's update leaves: ap_account says 2000, the line sits in 2000-7, the vendor tag is gone.
	const bill = { ...BILL, status: "open", due_date: "2999-01-01", journal_entry_id: 50, ap_account: "2000", tags_synced_at: new Date() };
	const row = { ...ROW, description: "HYDRO ONE", amount_cents: -8550n, suggested_code: "2000", chosen_code: "2000" };
	const o = ownBooks();
	o.books.own(7, "vendor");
	o.entries.set(50, payableEntry(50, "2000-7", { amended: false, moves: [{ line: 2, from: "2000", to: "2000-7" }] }));
	const { call, posted, reversed } = await start({ answers: [...refreshed(bill), ...billPayment(row, bill)], ...o });
	// Syncing (startup, Sort now, the hourly refresh) neither sets nor removes a vendor tag, however often.
	await call("POST /sort-now");
	await call("POST /sort-now");
	assert.deepEqual(vendorChanges(o.tags), []);
	assert.deepEqual(shape(o.entries.get(50)), [["5100", "8550", "0"], ["2000-7", "0", "8550"]], "the line stays in the vendor's account");
	// The move isn't shown as a change of the bill's amount.
	const shown = await call("GET /bills/:id", { params: { id: "3" } });
	assert.equal(shown.bill.entry_amended, undefined);
	assert.equal(shown.bill.payable_account.code, "2000-7");
	// The row matched before the update (booked to 2000) still pays the bill, in the account its line is in now.
	await call("POST /statements/:id/post", { params: { id: "1" }, body: {} });
	assert.deepEqual(shape(posted[0]), [["1000", "0", "8550"], ["2000-7", "8550", "0"]]);
	assert.equal(bill.status, "paid");
	assert.equal(o.books.owed(7), 0n);
	// Undoing the approval of such a bill reverses its entry and leaves the lines where they are.
	const open = { ...BILL, status: "open", journal_entry_id: 50, ap_account: "2000", tags_synced_at: new Date() };
	const again = ownBooks();
	again.books.own(7, "vendor");
	again.entries.set(50, payableEntry(50, "2000-7"));
	const b = await start({ answers: billTable(open), ...again });
	await b.call("POST /bills/:id/unapprove", { params: { id: "3" } });
	assert.deepEqual(b.reversed, [50]);
	assert.deepEqual([open.status, open.journal_entry_id, open.ap_account], ["new", null, null]);
	assert.deepEqual(vendorChanges(again.tags), [], "the reversed entry's line isn't moved back");
	assert.equal(again.entries.get(50).lines[1].account_code, "2000-7");
});

test("vendor accounts: a bill approved without a vendor is moved into the vendor's account once it has one; a changed vendor moves the bill and its payments", async () => {
	const bill = { ...BILL, status: "open", due_date: "2999-01-01", journal_entry_id: 50, paid_entry_id: null, ap_account: "2000", vendor: "Hydro One", vendor_entity_id: 7, tags_synced_at: new Date() };
	const o = ownBooks();
	o.entries.set(50, payableEntry(50, "2000"));
	// A payment this module posted for it, to the vendor's account.
	o.entries.set(60, { id: 60, entry_date: "2026-03-15", description: "HYDRO ONE", reversed_by_id: null, reverses_id: null, links: [{ module_id: "categorizer" }], lines: [{ account_code: "1000", debit_cents: 0n, credit_cents: 4000n }, { account_code: o.books.own(7, "vendor").code, debit_cents: 4000n, credit_cents: 0n }] });
	const answers = [
		[/SELECT vendor, customer_name FROM mod_categorizer\.bills/, () => [{ vendor: bill.vendor, customer_name: "" }]],
		[/FROM mod_categorizer\.transactions t WHERE t\.bill_id = \$1 ORDER BY t\.id DESC/, () => [{ id: 8n, status: "posted", journal_entry_id: 60n, account_code: "1000", amount_cents: -4000n }]],
		...refreshed(bill),
		...billTable(bill),
	];
	const { call } = await start({ answers, entities: { "Hydro One": 7, "Hydro Two": 9 }, ...o });
	// The sync claims the line for the bill's vendor: Ledger moves it, nothing is kept as a tag.
	await call("POST /sort-now");
	assert.equal(o.entries.get(50).lines[1].account_code, "2000-7");
	assert.deepEqual(o.tags.kept(50), []);
	assert.equal(o.books.owed(7), 4550n);
	// The vendor is corrected on the bill: its entry and its payment move to the new vendor's account.
	await call("PATCH /bills/:id", { params: { id: "3" }, body: { vendor: "Hydro Two" } });
	assert.equal(String(bill.vendor_entity_id), "9");
	assert.equal(o.entries.get(50).lines[1].account_code, "2000-9");
	assert.equal(o.entries.get(60).lines[1].account_code, "2000-9");
	assert.deepEqual([o.books.owed(7), o.books.owed(9)], [0n, 4550n]);
	assert.deepEqual([o.tags.kept(50), o.tags.kept(60)], [[], []]);
	// Saving again changes nothing.
	const before = o.tags.log.length;
	await call("PATCH /bills/:id", { params: { id: "3" }, body: { vendor: "Hydro Two" } });
	assert.equal(o.tags.log.length, before);
});

test("vendor accounts: unlinking a bill from an entry it was linked to by hand doesn't move that entry's line back", async () => {
	const bill = { ...BILL, status: "open", due_date: "2999-01-01", ap_account: null };
	const o = ownBooks();
	// Entered by hand in Ledger: Dr utilities / Cr accounts payable.
	o.entries.set(70, payableEntry(70, "2000", { links: [] }));
	const { call } = await start({ answers: [[/SELECT vendor, vendor_entity_id FROM mod_categorizer\.bills/, () => [{ vendor: bill.vendor, vendor_entity_id: 7 }]], ...billTable(bill)], ...o });
	await call("POST /bills/:id/link-entry", { params: { id: "3" }, body: { entry_id: 70 } });
	assert.equal(bill.status, "paid");
	assert.equal(o.entries.get(70).lines[1].account_code, "2000-7", "said to be this vendor's bill: Ledger moves its payable line");
	await call("POST /bills/:id/unlink-entry", { params: { id: "3" } });
	assert.equal(bill.status, "open");
	assert.equal(o.entries.get(70).lines[1].account_code, "2000-7", "unlinking is no reason to move it back");
	assert.deepEqual(o.tags.kept(70), []);
});

test("vendor accounts: a deposit that pays a customer's invoice is booked to the customer's own account, also when the line moved after the offer", async () => {
	const o = ownBooks();
	const own = o.books.own(4, "customer").code;
	assert.equal(own, "1200-4");
	const inv = { ...invoice(10, 50000n, []), lines: [{ account_code: own, debit_cents: 50000n, credit_cents: 0n }, { account_code: "4000", debit_cents: 0n, credit_cents: 50000n }] };
	o.entries.set(10, inv);
	await o.tags.setAs("sales", 10, "billed");
	const follow = (row) => [[/SET suggested_code = \$2 WHERE id = \$1 AND status = 'new' AND source = 'tag'/, (_, [, code]) => { row.suggested_code = code; return { rows: [], rowCount: 1 }; }], ...rowTable(row)];
	// Offered: the row's account is the line's real account, and the customer is read from it.
	const row = { ...ROW, description: "E-TRANSFER ENTITY 4" };
	const a = await start({ answers: follow(row), ...o });
	assert.equal((await a.call("POST /sort-now")).tag_matches, 1);
	assert.equal(row.suggested_code, "1200-4");
	assert.equal(row.confidence, 0.9, "the customer's name is in the description");
	const page = await a.call("GET /statements/:id", { params: { id: "1" } });
	assert.deepEqual(page.own_accounts, [], "(no rows are answered here; the page gets the names of own accounts its rows use)");
	await a.call("POST /statements/:id/post", { params: { id: "1" }, body: {} });
	assert.deepEqual(shape(a.posted[0]), [["1000", "50000", "0"], ["1200-4", "0", "50000"]]);
	assert.deepEqual(o.tags.kept(10), ["billed", "paid"]);
	assert.deepEqual(o.tags.kept(a.posted[0].id), [], "the payment needs no customer tag: its line is in the customer's account");
	assert.equal(o.books.owed(4), 0n);

	// Offered accounts receivable before Ledger moved the invoice's line: Sort now follows it, and so does posting by itself.
	for (const sortFirst of [true, false]) {
		const p = ownBooks();
		p.books.own(4, "customer");
		p.entries.set(10, { ...inv, lines: inv.lines.map((l) => ({ ...l })) });
		await p.tags.setAs("sales", 10, "billed");
		const stale = { ...ROW, pays_entry_id: 10, suggested_code: "1200", source: "tag", confidence: 0.9 };
		const b = await start({ answers: follow(stale), ...p });
		if (sortFirst) {
			await b.call("POST /sort-now");
			assert.equal(stale.suggested_code, "1200-4");
		}
		await b.call("POST /statements/:id/post", { params: { id: "1" }, body: {} });
		assert.deepEqual(shape(b.posted[0]), [["1000", "50000", "0"], ["1200-4", "0", "50000"]]);
		assert.deepEqual(p.tags.kept(10), ["billed", "paid"]);
	}
});

test("vendor accounts: a payment that pays another module's bill is booked to the vendor's own account", () => {
	const accounts = new Map(TAGGED().map((a) => [a.code, a]));
	accounts.set("2000-7", { code: "2000-7", name: "Hydro One", type: "liability", currency: "CAD", is_active: true, kind: null, parent_code: "2000", entity: { id: 7, name: "Hydro One", role: "vendor" } });
	const out = { id: 1n, account_code: "1000", date: "2026-03-15", description: "HYDRO ONE", amount_cents: -50000n };
	// Tagged by Ledger from the account: { id: 0, tag: "vendor", account_code }.
	const owed = { ...invoice(20, 50000n, [{ id: 0, tag: "vendor", entity: { id: 7, name: "Hydro One" }, account_code: "2000-7" }]), lines: [{ account_code: "5100", debit_cents: 50000n, credit_cents: 0n }, { account_code: "2000-7", debit_cents: 0n, credit_cents: 50000n }] };
	assert.deepEqual(payableCandidates(out, [owed], accounts, "categorizer").map((c) => [c.entry_id, c.account_code, c.role, c.named, c.who.id]), [[20, "2000-7", "vendor", true, 7]]);
});

// ---------------------------------------------------------------------------
// Create bill on a card or loan statement: accounts payable stands in (0.29.0, Ledger 0.32.0)
// ---------------------------------------------------------------------------

const VISA = { code: "2100", name: "Visa", type: "liability", currency: "CAD", is_active: true, kind: "credit_card", parent_code: null, entity: null };
const STATEMENT_BILL = { ...BILL, status: "new", vendor: "", invoice_number: null, bill_date: null, due_date: null, amount_cents: null, account_code: null, vendor_entity_id: 7, statement_id: 9n, standin_account_code: null, standin_line: null, standin_tx_id: null };
const CREATE = { kind: "bill", statement_id: "9", currency: "CAD", vendor: "Visa", bill_date: "2026-03-01", due_date: "2999-01-01", amount: "850.00" };
/** The payment received on the card's own statement (a later one than the bill's). */
const CARD_ROW = { id: 21n, statement_id: 12n, account_code: "2100", date: "2026-03-18", description: "PAYMENT - THANK YOU", amount_cents: 85000n, status: "new", journal_entry_id: null, transfer_tx_id: null, filename: "visa-april.csv" };

/** Create bill's own queries, the card's row, and the bill; `rest` answers what isn't about the card's row. */
function statementBill(bill, card, rest = billTable(bill)) {
	const next = (sql, params) => {
		for (const [p, a] of rest) if (p.test(sql)) return a(sql, params);
		return [];
	};
	const mine = (params) => String(params[0]) === String(card.id);
	return [
		[/SELECT id FROM mod_categorizer\.statements WHERE id = \$1/, () => [{ id: 9n }]],
		[/SELECT id FROM mod_categorizer\.bills WHERE statement_id = \$1/, () => []],
		[/INSERT INTO mod_categorizer\.bills \(source, vendor, updated_by, statement_id\)/, (_, [source, vendor]) => { Object.assign(bill, { source, vendor }); return [{ id: 3n }]; }],
		[/SELECT account_code FROM mod_categorizer\.statements WHERE id = \$1/, () => [{ account_code: "2100" }]],
		[/FROM mod_categorizer\.transactions t JOIN mod_categorizer\.statements s ON s\.id = t\.statement_id WHERE t\.id = \$1/, (_, params) => (mine(params) ? [{ ...card }] : [])],
		[/SET status = 'posting' WHERE id = \$1 AND status = 'new'/, (sql, params) => {
			if (!mine(params)) return next(sql, params);
			if (card.status !== "new") return { rows: [], rowCount: 0 };
			card.status = "posting";
			return { rows: [], rowCount: 1 };
		}],
		[/SET status = 'new' WHERE id = \$1 AND status = 'posting'/, (sql, params) => {
			if (!mine(params)) return next(sql, params);
			if (card.status === "posting") card.status = "new";
			return { rows: [], rowCount: 1 };
		}],
		[/SET status = 'posted', journal_entry_id = \$2/, (sql, params) => {
			if (!mine(params)) return next(sql, params);
			Object.assign(card, { status: "posted", journal_entry_id: params[1], reason: params[3] });
			return { rows: [], rowCount: 1 };
		}],
		[/SET status = 'new', journal_entry_id = NULL/, (_, [, entry]) => {
			if (card.status === "posted" && String(card.journal_entry_id) === String(entry)) Object.assign(card, { status: "new", journal_entry_id: null });
			return { rows: [], rowCount: 1 };
		}],
		[/b\.standin_account_code IS NOT NULL AND b\.standin_line IS NOT NULL AND b\.standin_tx_id IS NULL/, () =>
			bill.standin_account_code && bill.standin_line != null && bill.standin_tx_id == null && bill.journal_entry_id ? [{ ...bill, home: "2100" }] : []],
		[/WHERE t\.statement_id = \$1 AND t\.status = 'new' AND t\.amount_cents > 0/, () => (card.status === "new" ? [{ ...card }] : [])],
		...rest,
	];
}
/** Ledger 0.32.0: vendors' own accounts, a card account, and ctx.ledger.moveLine. */
const cardBooks = () => ({ ...ownBooks([...TAGGED(), VISA, CLEARING]), moveLine: true, moves: [] });

test("Create bill on a statement: accounts payable stands in for the card, the vendor's own account is credited; linking the card's payment row moves the line to the card", async () => {
	const bill = { ...STATEMENT_BILL };
	const card = { ...CARD_ROW };
	const bank = { ...ROW, description: "VISA PAYMENT", amount_cents: -85000n, suggested_code: "2000" };
	const o = cardBooks();
	const payment = billPayment(bank, bill).map(([p, a]) => (/SELECT b\.id, b\.amount_cents FROM/.test(p.source) ? [p, () => [{ id: 3n, amount_cents: 85000n }]] : /AS linked,/.test(p.source) ? [p, () => [{ linked: "85000", posted: "85000" }]] : [p, a]));
	const { call, posted, reversed } = await start({ answers: statementBill(bill, card, payment), ...o });

	// Create bill: Dr accounts payable (the stand-in) / Cr the card company's own account, posted as written.
	const r = await call("POST /bills", { body: CREATE });
	assert.equal(r.status, 201);
	assert.deepEqual(shape(posted[0]), [["2000", "85000", "0"], ["2000-7", "0", "85000"]]);
	assert.equal(posted[0].entity_id, 7);
	assert.deepEqual([bill.status, bill.source, bill.account_code, bill.standin_account_code, bill.standin_line, bill.ap_account, bill.journal_entry_id], ["open", "statement", "2000", "2000", 1, "2000", 100]);
	assert.equal(o.books.owed(7), 85000n, "the vendor is owed the statement's balance");
	assert.deepEqual(vendorChanges(o.tags), [], "no vendor tag is set: that would move the stand-in line into the vendor's account");
	assert.equal((await call("GET /status")).payables.statement_bills, "standin");

	// The payment received on the card's own statement is offered the bill, under its row.
	const jm = await call("GET /statements/:id/journal-matches", { params: { id: "12" } });
	assert.deepEqual(jm.bills.map((m) => [String(m.transaction_id), String(m.bill.id), m.bill.entry_id]), [["21", "3", 100]]);
	const page = await call("GET /bills/:id", { params: { id: "3" } });
	assert.equal(page.bill.standin.can_link, true);
	assert.equal(page.bill.standin.linked, null);
	assert.equal(page.bill.payable_account.code, "2000-7");

	// Only a row for the whole line: a part payment isn't linked.
	card.amount_cents = 30000n;
	await assert.rejects(call("POST /bills/:id/link-statement-row", { params: { id: "3" }, body: { transaction_id: "21" } }), (e) => e.status === 422 && /exactly 850\.00/.test(e.message));
	assert.deepEqual([card.status, o.moves.length], ["new", 0]);
	card.amount_cents = 85000n;

	// A person links it: the stand-in line moves to the card, and the row is settled by the bill's entry.
	await call("POST /bills/:id/link-statement-row", { params: { id: "3" }, body: { transaction_id: "21" } });
	assert.deepEqual(shape(o.entries.get(100)), [["2100", "85000", "0"], ["2000-7", "0", "85000"]]);
	assert.deepEqual([card.status, card.journal_entry_id, String(bill.standin_tx_id)], ["posted", 100, "21"]);
	assert.match(card.reason, /^recorded with bill 3/);
	assert.equal(posted.length, 1, "nothing is posted for the row itself");
	assert.equal(o.books.owed(7), 85000n);
	assert.deepEqual((await call("GET /statements/:id/journal-matches", { params: { id: "12" } })).bills, [], "it isn't offered again");
	const linked = await call("GET /bills/:id", { params: { id: "3" } });
	assert.equal(String(linked.bill.standin.linked.id), "21");
	assert.equal(linked.bill.entry_amended, undefined, "the moved line isn't a changed amount of the bill");
	await assert.rejects(call("POST /bills/:id/link-statement-row", { params: { id: "3" }, body: { transaction_id: "21" } }), (e) => e.status === 409);

	// Unlink: the line is back in accounts payable and the row waits to be posted again.
	await call("POST /bills/:id/unlink-statement-row", { params: { id: "3" } });
	assert.deepEqual(shape(o.entries.get(100)), [["2000", "85000", "0"], ["2000-7", "0", "85000"]]);
	assert.deepEqual([card.status, card.journal_entry_id, bill.standin_tx_id], ["new", null, null]);
	assert.equal((await call("GET /bills/:id", { params: { id: "3" } })).bill.entry_amended, undefined);
	await assert.rejects(call("POST /bills/:id/unlink-statement-row", { params: { id: "3" } }), (e) => e.status === 409);

	// Linked again; a line ticked on a reconciliation can't go back, so Unlink and Undo approval say so and change nothing.
	await call("POST /bills/:id/link-statement-row", { params: { id: "3" }, body: { transaction_id: "21" } });
	o.entries.get(100).lines[0].reconciled = true;
	await assert.rejects(call("POST /bills/:id/unlink-statement-row", { params: { id: "3" } }), (e) => e.status === 409 && /reconciliation/.test(e.message));
	await assert.rejects(call("POST /bills/:id/unapprove", { params: { id: "3" } }), (e) => e.status === 409 && /reconciliation/.test(e.message));
	assert.deepEqual([card.status, String(bill.standin_tx_id), bill.journal_entry_id, reversed.length], ["posted", "21", 100, 0]);
	o.entries.get(100).lines[0].reconciled = false;

	// The payment from the bank still pays the bill: Dr the vendor's own account / Cr the bank.
	await call("POST /statements/:id/post", { params: { id: "1" }, body: {} });
	assert.deepEqual(shape(posted[1]), [["1000", "0", "85000"], ["2000-7", "85000", "0"]]);
	assert.equal(bill.status, "paid");
	assert.equal(o.books.owed(7), 0n);
	assert.deepEqual(shape(o.entries.get(100)), [["2100", "85000", "0"], ["2000-7", "0", "85000"]], "the bill's entry: Dr the card / Cr the vendor");
});

test("stand-in bill: undoing the approval moves a linked line back first, frees the row and reverses the entry; approving again posts the stand-in anew", async () => {
	const bill = { ...STATEMENT_BILL };
	const card = { ...CARD_ROW };
	const o = cardBooks();
	const { call, posted, reversed } = await start({ answers: statementBill(bill, card), ...o });
	await call("POST /bills", { body: CREATE });
	await call("POST /bills/:id/link-statement-row", { params: { id: "3" }, body: { transaction_id: "21" } });
	assert.equal(o.entries.get(100).lines[0].account_code, "2100");
	await call("POST /bills/:id/unapprove", { params: { id: "3" } });
	assert.deepEqual(shape(o.entries.get(100)), [["2000", "85000", "0"], ["2000-7", "0", "85000"]], "reversed as it was posted");
	assert.deepEqual(reversed, [100]);
	assert.deepEqual([card.status, card.journal_entry_id], ["new", null]);
	assert.deepEqual([bill.status, bill.journal_entry_id, bill.ap_account, bill.standin_line, bill.standin_tx_id, bill.standin_account_code], ["new", null, null, null, null, "2000"]);
	// Approved again: the same posting, with the line's number kept for the next link.
	await call("POST /bills/:id/approve", { params: { id: "3" } });
	assert.deepEqual(shape(posted[1]), [["2000", "85000", "0"], ["2000-7", "0", "85000"]]);
	assert.deepEqual([bill.status, bill.journal_entry_id, bill.standin_line], ["open", 101, 1]);
	// Given an account of its own by a person while it isn't posted, it is an ordinary bill again.
	await call("POST /bills/:id/unapprove", { params: { id: "3" } });
	await call("PATCH /bills/:id", { params: { id: "3" }, body: { account_code: "5100" } });
	assert.deepEqual([bill.account_code, bill.standin_account_code], ["5100", null]);
});

test("stand-in bill: a changed vendor moves the credit to the new vendor's account and leaves the stand-in line in accounts payable", async () => {
	const bill = { ...STATEMENT_BILL };
	const o = cardBooks();
	const answers = [[/SELECT vendor, customer_name FROM mod_categorizer\.bills/, () => [{ vendor: bill.vendor, customer_name: "" }]], ...statementBill(bill, { ...CARD_ROW })];
	const { call } = await start({ answers, entities: { Visa: 7, "Visa Canada": 9 }, ...o });
	await call("POST /bills", { body: CREATE });
	assert.equal(o.books.owed(7), 85000n);
	await call("PATCH /bills/:id", { params: { id: "3" }, body: { vendor: "Visa Canada" } });
	assert.equal(String(bill.vendor_entity_id), "9");
	assert.deepEqual(shape(o.entries.get(100)), [["2000", "85000", "0"], ["2000-9", "0", "85000"]]);
	assert.deepEqual([o.books.owed(7), o.books.owed(9)], [0n, 85000n]);
	assert.deepEqual(vendorChanges(o.tags), [], "not through the vendor tag: that would take the stand-in line along");
	// A posted stand-in bill keeps a vendor.
	await assert.rejects(call("PATCH /bills/:id", { params: { id: "3" }, body: { vendor: "" } }), (e) => e.status === 409);
});

test("Create bill on a statement keeps the clearing account where the stand-in can't be used: Ledger 0.31 (no moveLine), or a bill whose vendor isn't on Ledger's list", async () => {
	// Ledger 0.31: vendors' own accounts, but no way to move a line.
	const old = { ...STATEMENT_BILL };
	const a = ownBooks([...TAGGED(), VISA, CLEARING]);
	const first = await start({ answers: statementBill(old, { ...CARD_ROW }), ...a });
	await first.call("POST /bills", { body: CREATE });
	assert.deepEqual(shape(first.posted[0]), [["2990", "85000", "0"], ["2000-7", "0", "85000"]], "Dr the clearing account / Cr payables, which Ledger keeps in the vendor's account");
	assert.deepEqual([old.account_code, old.standin_account_code, old.standin_line], ["2990", null, null]);
	assert.equal((await first.call("GET /status")).payables.statement_bills, "clearing");
	assert.equal((await first.call("GET /bills/:id", { params: { id: "3" } })).bill.standin, null);
	assert.deepEqual((await first.call("GET /statements/:id/journal-matches", { params: { id: "12" } })).bills, []);
	await assert.rejects(first.call("POST /bills/:id/link-statement-row", { params: { id: "3" }, body: { transaction_id: "21" } }), (e) => e.status === 409 && /stand-in/.test(e.message));
	// Ledger 0.32, but the vendor couldn't be put on Ledger's list: debit and credit would be one account.
	const lone = { ...STATEMENT_BILL, vendor_entity_id: null };
	const b = cardBooks();
	const second = await start({ answers: statementBill(lone, { ...CARD_ROW }), ...b });
	await second.call("POST /bills", { body: CREATE });
	assert.deepEqual(shape(second.posted[0]), [["2990", "85000", "0"], ["2000", "0", "85000"]]);
	assert.deepEqual([lone.account_code, lone.standin_account_code], ["2990", null]);
	// A bill posted to the clearing account before 0.29.0 stays as it is on a newer Ledger.
	const before = { ...STATEMENT_BILL, status: "open", vendor: "Visa", amount_cents: 85000n, account_code: "2990", ap_account: "2000", journal_entry_id: 50, source: "statement" };
	const c = cardBooks();
	c.entries.set(50, { id: 50, entry_date: "2026-03-01", description: "Visa bill", reversed_by_id: null, reverses_id: null, links: [{ module_id: "categorizer" }], lines: [{ account_code: "2990", debit_cents: 85000n, credit_cents: 0n }, { account_code: c.books.own(7, "vendor").code, debit_cents: 0n, credit_cents: 85000n }] });
	const third = await start({ answers: [...refreshed(before), ...statementBill(before, { ...CARD_ROW })], ...c });
	await third.call("POST /sort-now");
	assert.deepEqual(shape(c.entries.get(50)), [["2990", "85000", "0"], ["2000-7", "0", "85000"]]);
	assert.equal(c.moves.length, 0, "no posted entry is rewritten");
	assert.equal((await third.call("GET /bills/:id", { params: { id: "3" } })).bill.standin, null);
});

// ---------------------------------------------------------------------------
// Linked payments (0.30.0, Ledger 0.33.0): a payment is linked to the bill's entry, no line is moved,
// and Ledger keeps unpaid / partially_paid / paid on the bill's entry
// ---------------------------------------------------------------------------

/** Ledger 0.33.0: vendors' own accounts, a card account, moveLine (which must not be used for new links) and linked payments. */
function ledger33(accounts = [...TAGGED(), VISA, CLEARING]) {
	const o = ownBooks(accounts);
	const payments = fakePayments(o.entries, { accounts: () => o.accounts, setTag: (by, id, tag) => o.tags.setAs(by, id, tag) });
	return { ...o, payments, moveLine: true, moves: [] };
}
/** The tag changes on an entry, as "who:action tag". */
const changes = (tags, entryId, from = 0) => tags.log.slice(from).filter((c) => c.entry_id === entryId && ["paid", "partially_paid", "unpaid"].includes(c.tag)).map((c) => `${c.module_id ?? "person"}:${c.action} ${c.tag}`);
const linkCalls = (payments) => payments.calls.filter((c) => c[0] === "link").map(([, bill, payment, amount]) => [bill, payment, amount]);
/** The same statement row object stands for the next row to post. */
const nextRow = (row, change) => Object.assign(row, { status: "new", journal_entry_id: null, pays_entry_id: null }, change);

test("linked payments: an approved bill's entry is tagged unpaid; a part payment is linked with its amount (partially paid), the rest makes it paid, and no line of the bill's entry moves", async () => {
	const bill = { ...BILL, due_date: "2999-01-01" };
	const row = { ...ROW, description: "HYDRO ONE", amount_cents: -3000n, suggested_code: "2000" };
	const o = ledger33();
	const { call, posted, related } = await start({ answers: billPayment(row, bill), ...o });
	await call("POST /bills/:id/approve", { params: { id: "3" } });
	assert.deepEqual(shape(posted[0]), [["5100", "8550", "0"], ["2000-7", "0", "8550"]]);
	assert.deepEqual(o.tags.kept(100), ["unpaid"], "a new bill's entry is unpaid");
	assert.ok(bill.payments_linked_at, "from approval on, Ledger's linked payments say what is paid");
	assert.equal((await call("GET /status")).payables.linked_payments, true);
	let page = await call("GET /bills/:id", { params: { id: "3" } });
	assert.deepEqual([page.bill.payment_status, page.bill.paid_cents, page.bill.left_cents, page.bill.payments_from], ["unpaid", 0n, 8550n, "ledger"]);

	// A part payment: posted to the vendor's account and linked to the bill's entry for what it pays.
	await call("POST /statements/:id/post", { params: { id: "1" }, body: {} });
	assert.deepEqual(shape(posted[1]), [["1000", "0", "3000"], ["2000-7", "3000", "0"]]);
	assert.deepEqual(linkCalls(o.payments), [[100, 101, 3000n]]);
	assert.match(o.payments.links[0].note, /payment of bill Hydro One H-1/);
	assert.deepEqual(o.tags.kept(100), ["partially_paid"], "Ledger's tag, set through the link: the module sets none itself");
	assert.equal(bill.status, "open");
	page = await call("GET /bills/:id", { params: { id: "3" } });
	assert.deepEqual([page.bill.payment_status, page.bill.paid_cents, page.bill.left_cents, page.bill.due_cents], ["partially_paid", 3000n, 5550n, 8550n]);

	// The rest: Ledger says paid, and so does the bill.
	nextRow(row, { id: 8n, amount_cents: -5550n });
	await call("POST /statements/:id/post", { params: { id: "1" }, body: {} });
	assert.deepEqual(linkCalls(o.payments), [[100, 101, 3000n], [100, 102, 5550n]]);
	assert.deepEqual(o.tags.kept(100), ["paid"]);
	assert.deepEqual([bill.status, bill.paid_entry_id, bill.paid_by_tag], ["paid", 102, false]);
	assert.equal((await call("GET /bills/:id", { params: { id: "3" } })).bill.payment_status, "paid");
	// Neither entry changed, nothing was moved, and the payment link replaces the plain link of before.
	assert.deepEqual(shape(o.entries.get(100)), [["5100", "8550", "0"], ["2000-7", "0", "8550"]]);
	assert.equal(o.moves.length, 0);
	assert.deepEqual(related, []);
	assert.equal(o.books.owed(7), 0n);
	// Every status tag on the bill's entry came from the module's "unpaid" and from Ledger's own (made in the module's name through the link).
	assert.deepEqual(changes(o.tags, 100), ["categorizer:set unpaid", "categorizer:set partially_paid", "categorizer:removed unpaid", "categorizer:set paid", "categorizer:removed partially_paid"]);
});

test("linked payments: the bill follows Ledger's tag when a payment is reversed, taken off or linked there, and nothing loops", async () => {
	const bill = { ...BILL, status: "paid", due_date: "2999-01-01", journal_entry_id: 50, paid_entry_id: 61, ap_account: "2000", tags_synced_at: new Date(), payments_linked_at: new Date() };
	const o = ledger33();
	const own = o.books.own(7, "vendor").code;
	o.entries.set(50, payableEntry(50, own));
	const pay = (id, cents) => ({ id, entry_date: "2026-03-15", description: "HYDRO ONE", reversed_by_id: null, reverses_id: null, links: [{ module_id: "categorizer" }], lines: [{ account_code: "1000", debit_cents: 0n, credit_cents: cents }, { account_code: own, debit_cents: cents, credit_cents: 0n }] });
	o.entries.set(60, pay(60, 3000n));
	o.entries.set(61, pay(61, 5550n));
	o.entries.set(62, pay(62, 5550n));
	await o.payments.api.linkPayment(50, 60, { amount_cents: 3000n });
	await o.payments.api.linkPayment(50, 61, { amount_cents: 5550n });
	assert.deepEqual(o.tags.kept(50), ["paid"]);
	const { call, posted } = await start({ answers: [...refreshed(bill), ...billTable(bill)], ...o });
	let at = o.tags.log.length;

	// A person reverses one payment in Ledger: Ledger tags the entry partially paid, and the bill is open again.
	await o.payments.reversed(61);
	assert.deepEqual([bill.status, bill.paid_entry_id], ["open", null]);
	assert.deepEqual(changes(o.tags, 50, at), ["person:set partially_paid", "person:removed paid"], "only Ledger's own changes: the module set nothing against them");
	let page = await call("GET /bills/:id", { params: { id: "3" } });
	assert.deepEqual([page.bill.payment_status, page.bill.paid_cents, page.bill.left_cents], ["partially_paid", 3000n, 5550n]);
	assert.deepEqual(page.bill.other_payments.map((x) => [x.entry_id, x.counted]), [[60, true], [61, false]]);
	// Syncing again and again (Sort now, the hourly refresh) changes nothing.
	at = o.tags.log.length;
	await call("POST /sort-now");
	await call("POST /sort-now");
	assert.equal(o.tags.log.length, at);
	assert.equal(bill.status, "open");

	// Another payment is linked in Ledger (a person, or another module): paid again, by its payments.
	await o.payments.linked(50, 62, 5550n, "payments");
	assert.deepEqual([bill.status, String(bill.paid_entry_id), bill.paid_by_tag], ["paid", "62", false]);
	assert.deepEqual(changes(o.tags, 50, at), ["payments:set paid", "payments:removed partially_paid"]);
	// Reopen is refused while the linked payments cover it: the tag would not hold.
	await assert.rejects(call("PATCH /bills/:id", { params: { id: "3" }, body: { status: "open" } }), (e) => e.status === 409 && /linked/.test(e.message));

	// Someone takes "paid" off although the payments cover it: it goes back once, and that is all.
	at = o.tags.log.length;
	await o.tags.removeAs(null, 50, "paid");
	assert.deepEqual(changes(o.tags, 50, at), ["person:removed paid", "categorizer:set paid"]);
	assert.equal(bill.status, "paid");

	// A person takes a payment off the entry on its page in Ledger: partially paid, open.
	at = o.tags.log.length;
	await o.payments.unlinked(50, 62);
	assert.equal(bill.status, "open");
	assert.deepEqual(changes(o.tags, 50, at), ["person:set partially_paid", "person:removed paid"]);
	// And the last counted one: unpaid.
	await o.payments.unlinked(50, 60);
	assert.deepEqual(o.tags.kept(50), ["unpaid"]);
	assert.equal(bill.status, "open");
	assert.equal(posted.length, 0, "nothing is ever posted in reaction to a tag");
	assert.equal(o.moves.length, 0);
});

test("linked payments: Mark paid and paid by tag still set and follow paid themselves, where there is no payment entry to link", async () => {
	const bill = { ...BILL, status: "open", due_date: "2999-01-01", journal_entry_id: 50, ap_account: "2000", tags_synced_at: new Date(), payments_linked_at: new Date() };
	const o = ledger33();
	o.entries.set(50, payableEntry(50, o.books.own(7, "vendor").code));
	const { call } = await start({ answers: [...refreshed(bill), ...billTable(bill)], ...o });
	await call("POST /sort-now");
	assert.deepEqual(o.tags.kept(50), ["unpaid"], "an approved bill from before gets its unpaid tag at the next sync");
	// Mark paid: the module's own "paid" (no payment to link); Ledger takes "unpaid" off.
	await call("PATCH /bills/:id", { params: { id: "3" }, body: { status: "paid" } });
	assert.deepEqual(o.tags.kept(50), ["paid"]);
	assert.equal(o.payments.links.length, 0);
	assert.equal((await call("GET /bills/:id", { params: { id: "3" } })).bill.payment_status, "paid");
	// Reopen: unpaid again.
	await call("PATCH /bills/:id", { params: { id: "3" }, body: { status: "open" } });
	assert.deepEqual([o.tags.kept(50), bill.status], [["unpaid"], "open"]);
	// Paid by tag: a person tags the entry paid in Ledger, then takes it off.
	await o.tags.setAs(null, 50, "paid", {}, { username: "sam" });
	assert.deepEqual([bill.status, bill.paid_by_tag, bill.paid_tag_by], ["paid", true, "sam"]);
	const at = o.tags.log.length;
	await o.tags.removeAs(null, 50, "paid");
	assert.deepEqual([bill.status, bill.paid_by_tag], ["open", false]);
	assert.deepEqual(changes(o.tags, 50, at), ["person:removed paid", "categorizer:set unpaid"], "one of the three is back, set once");
	// Tagged unpaid by hand while marked paid: the bill follows.
	await call("PATCH /bills/:id", { params: { id: "3" }, body: { status: "paid" } });
	await o.tags.setAs(null, 50, "unpaid");
	assert.equal(bill.status, "open");
	// Overdue as before: an unpaid bill past its due date.
	bill.due_date = "2026-01-01";
	await call("POST /sort-now");
	assert.deepEqual(o.tags.kept(50), ["overdue", "unpaid"]);
});

test("linked payments: a bill linked by hand to the entry that paid it is linked there as its payment; unlinking takes the link off", async () => {
	const bill = { ...BILL, status: "open", due_date: "2999-01-01", journal_entry_id: 50, ap_account: "2000", tags_synced_at: new Date(), payments_linked_at: new Date() };
	const o = ledger33();
	const own = o.books.own(7, "vendor").code;
	o.entries.set(50, payableEntry(50, own));
	// Entered by hand in Ledger: one cheque that paid this bill and something else.
	o.entries.set(70, { id: 70, entry_date: "2026-03-20", description: "Cheque 114", reversed_by_id: null, reverses_id: null, links: [], lines: [{ account_code: "1000", debit_cents: 0n, credit_cents: 20000n }, { account_code: own, debit_cents: 8550n, credit_cents: 0n }, { account_code: "5100", debit_cents: 11450n, credit_cents: 0n }] });
	await o.tags.setAs("categorizer", 50, "unpaid");
	const { call } = await start({ answers: [[/SELECT vendor, vendor_entity_id FROM mod_categorizer\.bills/, () => [{ vendor: bill.vendor, vendor_entity_id: 7 }]], ...billTable(bill)], ...o });
	await call("POST /bills/:id/link-entry", { params: { id: "3" }, body: { entry_id: 70 } });
	assert.deepEqual(linkCalls(o.payments), [[50, 70, 8550n]], "linked for what was still to pay of the bill, not the whole cheque");
	assert.deepEqual([bill.status, bill.paid_entry_id, o.tags.kept(50)], ["paid", 70, ["paid"]]);
	const page = await call("GET /bills/:id", { params: { id: "3" } });
	assert.deepEqual(page.bill.other_payments.map((x) => [x.entry_id, x.amount_cents]), [[70, 8550n]]);
	await assert.rejects(call("POST /bills/:id/link-entry", { params: { id: "3" }, body: { entry_id: 50 } }), (e) => e.status === 409);
	await call("POST /bills/:id/unlink-entry", { params: { id: "3" } });
	assert.deepEqual(o.payments.calls.at(-1), ["unlink", 50, 70]);
	assert.deepEqual([bill.status, bill.paid_entry_id, o.tags.kept(50)], ["open", null, ["unpaid"]]);
	assert.deepEqual(shape(o.entries.get(50)), [["5100", "8550", "0"], [own, "0", "8550"]]);
});

/** Entered by hand in Ledger: one card payment of 200.00, all of it booked to utilities. */
const LARGER = () => ({ id: 70, entry_date: "2026-03-20", description: "Costco", reference: "chq 9", reversed_by_id: null, reverses_id: null, links: [], lines: [{ account_code: "5100", debit_cents: 20000n, credit_cents: 0n }, { account_code: "1000", debit_cents: 0n, credit_cents: 20000n }] });
const vendorAnswer = (bill) => [/SELECT vendor, vendor_entity_id FROM mod_categorizer\.bills/, () => [{ vendor: bill.vendor, vendor_entity_id: 7 }]];

test("entry split: an entry for more than the bill is shown with the line that can be split, and the split is an entry of its own that unlinking reverses", async () => {
	const bill = { ...BILL, status: "open", due_date: "2999-01-01", ap_account: null };
	const entries = new Map([[70, LARGER()]]);
	const { call, posted, related, reversed } = await start({ answers: [vendorAnswer(bill), ...billTable(bill)], entries, accounts: TAGGED() });
	const s = await call("GET /bills/:id/entry-split", { params: { id: "3" }, query: new URLSearchParams({ entry_id: "70" }) });
	assert.deepEqual([s.differs, s.owed_cents, s.total_cents, s.splittable, s.line_number, s.partial], [true, 8550n, 20000n, [1], 1, false]);
	assert.deepEqual(s.entry.lines.map((l) => [l.line_number, l.account_code, l.debit_cents, l.credit_cents]), [[1, "5100", 20000n, 0n], [2, "1000", 0n, 20000n]]);
	const link = (split) => call("POST /bills/:id/link-entry", { params: { id: "3" }, body: { entry_id: 70, split } });
	// The parts must add up to the rest of the line, in accounts that can be chosen.
	await assert.rejects(link({ lines: [{ amount: "100.00", account_code: "4000" }] }), (e) => e.status === 422 && /add up to 100\.00, but 114\.50/.test(e.message));
	await assert.rejects(link({ lines: [{ amount: "114.50", account_code: "9999" }] }), (e) => e.status === 422);
	await assert.rejects(link({ line_number: 2, lines: [{ amount: "114.50", account_code: "4000" }] }), (e) => e.status === 422 && /debit line/.test(e.message));
	assert.deepEqual([posted.length, bill.status], [0, "open"], "a refused split changes nothing");
	// 85.50 is the bill and stays in utilities; of the rest, 100.00 goes to sales and 14.50 stays.
	await link({ lines: [{ amount: "100.00", account_code: "4000", memo: "not ours" }, { amount: "14.50", account_code: "5100" }] });
	assert.deepEqual(shape(posted[0]), [["4000", "10000", "0"], ["5100", "0", "10000"]]);
	assert.equal(posted[0].entry_date, "2026-03-20");
	assert.match(posted[0].description, /^Split of entry #70: Costco/);
	assert.equal(posted[0].sent_links[0].ref, "bill-split:3");
	assert.deepEqual(related.map((r) => [r[0], r[1]]), [[100, 70]]);
	assert.deepEqual([bill.status, bill.paid_entry_id, bill.split_entry_id], ["paid", 70, 100]);
	assert.deepEqual(shape(entries.get(70)), [["5100", "20000", "0"], ["1000", "0", "20000"]], "the entry itself is as it was posted");
	await call("POST /bills/:id/unlink-entry", { params: { id: "3" } });
	assert.deepEqual([reversed, bill.status, bill.paid_entry_id, bill.split_entry_id], [[100], "open", null, null]);
});

test("entry split: the bill's own part can go to another account too; parts that stay post nothing", async () => {
	const bill = { ...BILL, status: "open", due_date: "2999-01-01", ap_account: null };
	const entries = new Map([[70, LARGER()]]);
	const { call, posted } = await start({ answers: [vendorAnswer(bill), ...billTable(bill)], entries, accounts: TAGGED() });
	await call("POST /bills/:id/link-entry", { params: { id: "3" }, body: { entry_id: 70, split: { line_number: 1, lines: [{ amount: "114.50", account_code: "5100" }] } } });
	assert.deepEqual([posted.length, bill.status, bill.split_entry_id], [0, "paid", null]);
	await call("POST /bills/:id/unlink-entry", { params: { id: "3" } });
	await call("POST /bills/:id/link-entry", { params: { id: "3" }, body: { entry_id: 70, split: { bill_account_code: "4000", lines: [{ amount: "114.50", account_code: "5100" }] } } });
	assert.deepEqual(shape(posted[0]), [["4000", "8550", "0"], ["5100", "0", "8550"]]);
	// An entry with a line for exactly the amount is not one to split.
	const exact = await call("GET /bills/:id/entry-split", { params: { id: "3" }, query: new URLSearchParams({ entry_id: "70" }) }).catch((e) => e);
	assert.equal(exact.differs, true);
	entries.set(71, { ...LARGER(), id: 71, lines: [{ account_code: "5100", debit_cents: 8550n, credit_cents: 0n }, { account_code: "1000", debit_cents: 0n, credit_cents: 8550n }] });
	assert.equal((await call("GET /bills/:id/entry-split", { params: { id: "3" }, query: new URLSearchParams({ entry_id: "71" }) })).differs, false);
});

test("entry split: with linked payments the entry is linked for the bill's share only, and an entry for less can be linked as a part payment", async () => {
	const bill = { ...BILL, status: "open", due_date: "2999-01-01", journal_entry_id: 50, ap_account: "2000", tags_synced_at: new Date(), payments_linked_at: new Date() };
	const o = ledger33();
	const own = o.books.own(7, "vendor").code;
	o.entries.set(50, payableEntry(50, own));
	o.entries.set(70, LARGER());
	o.entries.set(71, { ...LARGER(), id: 71, lines: [{ account_code: own, debit_cents: 3000n, credit_cents: 0n }, { account_code: "1000", debit_cents: 0n, credit_cents: 3000n }] });
	await o.tags.setAs("categorizer", 50, "unpaid");
	const { call, posted } = await start({ answers: [vendorAnswer(bill), ...billTable(bill)], ...o });
	// 30.00 of 85.50: a part payment, the bill stays open.
	const less = await call("GET /bills/:id/entry-split", { params: { id: "3" }, query: new URLSearchParams({ entry_id: "71" }) });
	assert.deepEqual([less.differs, less.splittable, less.partial], [true, [], true]);
	await assert.rejects(call("POST /bills/:id/link-entry", { params: { id: "3" }, body: { entry_id: 70, partial: true } }), (e) => e.status === 422);
	await call("POST /bills/:id/link-entry", { params: { id: "3" }, body: { entry_id: 71, partial: true } });
	assert.deepEqual(linkCalls(o.payments), [[50, 71, 3000n]]);
	assert.deepEqual([bill.status, bill.paid_entry_id, o.tags.kept(50)], ["open", null, ["partially_paid"]]);
	// The larger entry pays the rest: 55.50 is the bill's share, the other 144.50 is split.
	const more = await call("GET /bills/:id/entry-split", { params: { id: "3" }, query: new URLSearchParams({ entry_id: "70" }) });
	assert.deepEqual([more.owed_cents, more.splittable], [5550n, [1]]);
	await call("POST /bills/:id/link-entry", { params: { id: "3" }, body: { entry_id: 70, split: { lines: [{ amount: "144.50", account_code: "4000" }] } } });
	assert.deepEqual(linkCalls(o.payments).at(-1), [50, 70, 5550n]);
	assert.deepEqual(shape(posted[0]), [["4000", "14450", "0"], ["5100", "0", "14450"]]);
	assert.deepEqual([bill.status, bill.paid_entry_id, o.tags.kept(50)], ["paid", 70, ["paid"]]);
	assert.deepEqual(shape(o.entries.get(50)), [["5100", "8550", "0"], [own, "0", "8550"]], "the bill's entry is untouched");
});

test("linked payments: a posted payment marked not posted (root mode) is unlinked in Ledger, and the bill is partially paid again", async () => {
	const bill = { ...BILL, status: "paid", due_date: "2999-01-01", journal_entry_id: 50, paid_entry_id: 61, ap_account: "2000", tags_synced_at: new Date(), payments_linked_at: new Date() };
	const o = ledger33();
	const own = o.books.own(7, "vendor").code;
	o.entries.set(50, payableEntry(50, own));
	for (const [id, cents] of [[60, 3000n], [61, 5550n]]) o.entries.set(id, { id, entry_date: "2026-03-15", description: "HYDRO ONE", reversed_by_id: null, reverses_id: null, links: [], lines: [{ account_code: "1000", debit_cents: 0n, credit_cents: cents }, { account_code: own, debit_cents: cents, credit_cents: 0n }] });
	await o.payments.api.linkPayment(50, 60, { amount_cents: 3000n });
	await o.payments.api.linkPayment(50, 61, { amount_cents: 5550n });
	const row = { id: 8n, status: "posted", journal_entry_id: 61n, statement_id: 1n, bill_id: 3n, pays_entry_id: null, standin_bill_id: null };
	const rooted = [];
	const answers = [
		[/SELECT id, status, journal_entry_id, statement_id, bill_id, pays_entry_id, standin_bill_id FROM mod_categorizer\.transactions WHERE id = \$1/, () => [{ ...row }]],
		[/SELECT journal_entry_id FROM mod_categorizer\.bills WHERE id = \$1/, () => [{ journal_entry_id: bill.journal_entry_id }]],
		...billTable(bill),
	];
	const { call, reversed } = await start({ answers, ...o, root: { update: async (_req, table, id, set) => { rooted.push([table, String(id)]); if (table === "transactions") Object.assign(row, set); }, remove: async () => {}, onCheck() {} } });
	await call("POST /root/transactions/:id/unpost", { params: { id: "8" }, user: { username: "ada", role: "admin", root: true } });
	assert.deepEqual([row.status, row.journal_entry_id], ["new", null]);
	assert.deepEqual(o.payments.calls.at(-1), ["unlink", 50, 61]);
	assert.deepEqual([o.tags.kept(50), bill.status, bill.paid_entry_id], [["partially_paid"], "open", null]);
	assert.deepEqual(reversed, [], "its entry isn't touched");
});

test("linked payments: a deposit that pays another module's invoice is linked to it as its payment, and Ledger tags the invoice paid", async () => {
	const o = ledger33();
	const own = o.books.own(4, "customer").code;
	o.entries.set(10, { ...invoice(10, 50000n, []), lines: [{ account_code: own, debit_cents: 50000n, credit_cents: 0n }, { account_code: "4000", debit_cents: 0n, credit_cents: 50000n }] });
	await o.tags.setAs("sales", 10, "billed");
	await o.tags.setAs("sales", 10, "unpaid");
	const row = { ...ROW, description: "E-TRANSFER ENTITY 4" };
	const { call, posted, related } = await start({ answers: rowTable(row), ...o });
	assert.equal((await call("POST /sort-now")).tag_matches, 1);
	await call("POST /statements/:id/post", { params: { id: "1" }, body: {} });
	assert.deepEqual(shape(posted[0]), [["1000", "50000", "0"], [own, "0", "50000"]]);
	assert.deepEqual(linkCalls(o.payments), [[10, posted[0].id, 50000n]]);
	assert.deepEqual(o.tags.kept(10), ["billed", "paid"]);
	assert.deepEqual(related, [], "the payment link is the link");
	assert.deepEqual(shape(o.entries.get(10)), [[own, "50000", "0"], ["4000", "0", "50000"]], "the invoice's entry isn't changed");
	// A partially paid entry is paid by a row for exactly what is left of it.
	const accounts = new Map(o.accounts.map((a) => [a.code, a]));
	const part = { ...o.entries.get(10), id: 11, tags: [{ tag: "billed" }, { tag: "partially_paid" }] };
	const dep = (cents) => ({ id: 1n, account_code: "1000", date: "2026-03-15", description: "E-TRANSFER", amount_cents: cents });
	assert.deepEqual(payableCandidates(dep(50000n), [part], accounts, "categorizer"), [], "what is left isn't known: not offered");
	assert.deepEqual(payableCandidates(dep(50000n), [{ ...part, left_cents: 20000n }], accounts, "categorizer"), [], "the whole amount no longer pays it");
	assert.deepEqual(payableCandidates(dep(20000n), [{ ...part, left_cents: 20000n }], accounts, "categorizer").map((c) => [c.entry_id, c.account_code]), [[11, own]]);
});

/**
 * Create bill on a statement with rows of the card's own statement, kept in memory: the bill's
 * queries, and the rows' (by id, claimed, posted, released, the ones that clear the bill's stand-in).
 */
function standinBooks(bill, cards, rest = billTable(bill)) {
	const next = (sql, params) => {
		for (const [p, a] of rest) if (p.test(sql)) return a(sql, params);
		return [];
	};
	const byId = (params) => cards.find((c) => String(c.id) === String(params[0])) ?? null;
	const cleared = () => cards.filter((c) => c.status === "posted" && String(c.standin_bill_id ?? "") === String(bill.id));
	return [
		[/SELECT id FROM mod_categorizer\.statements WHERE id = \$1/, () => [{ id: 9n }]],
		[/SELECT id FROM mod_categorizer\.bills WHERE statement_id = \$1/, () => []],
		[/INSERT INTO mod_categorizer\.bills \(source, vendor, updated_by, statement_id\)/, (_, [source, vendor]) => { Object.assign(bill, { source, vendor }); return [{ id: 3n }]; }],
		[/SELECT account_code FROM mod_categorizer\.statements WHERE id = \$1/, () => [{ account_code: "2100" }]],
		[/WHERE t\.standin_bill_id = \$1 AND t\.status = 'posted'/, (_, [, only]) => cleared().filter((c) => only == null || String(c.id) === String(only)).map((c) => ({ ...c }))],
		[/t\.amount_cents > 0 AND t\.amount_cents <= \$2/, (_, [home, left]) => cards.filter((c) => c.status === "new" && c.account_code === home && c.amount_cents > 0n && c.amount_cents <= BigInt(left)).map((c) => ({ ...c }))],
		[/FROM mod_categorizer\.transactions t JOIN mod_categorizer\.statements s ON s\.id = t\.statement_id WHERE t\.id = \$1/, (_, params) => (byId(params) ? [{ ...byId(params) }] : [])],
		[/SET status = 'posting' WHERE id = \$1 AND status = 'new'/, (sql, params) => {
			const c = byId(params);
			if (!c) return next(sql, params);
			if (c.status !== "new") return { rows: [], rowCount: 0 };
			c.status = "posting";
			return { rows: [], rowCount: 1 };
		}],
		[/SET status = 'new' WHERE id = \$1 AND status = 'posting'/, (sql, params) => {
			const c = byId(params);
			if (!c) return next(sql, params);
			if (c.status === "posting") c.status = "new";
			return { rows: [], rowCount: 1 };
		}],
		[/SET status = 'posted', journal_entry_id = \$2/, (sql, params) => {
			const c = byId(params);
			if (!c) return next(sql, params);
			Object.assign(c, { status: "posted", journal_entry_id: params[1], reason: params[3], standin_bill_id: /standin_bill_id = \$5/.test(sql) ? params[4] : null, chosen_code: /chosen_code = \$6/.test(sql) ? params[5] : null });
			return { rows: [], rowCount: 1 };
		}],
		[/SET status = 'new', journal_entry_id = NULL/, (_, [id, entry]) => {
			const c = byId([id]);
			if (c && c.status === "posted" && String(c.journal_entry_id) === String(entry)) Object.assign(c, { status: "new", journal_entry_id: null, standin_bill_id: null, chosen_code: null });
			return { rows: [], rowCount: 1 };
		}],
		[/b\.standin_account_code IS NOT NULL AND b\.standin_line IS NOT NULL AND b\.standin_tx_id IS NULL/, () =>
			bill.standin_account_code && bill.standin_line != null && bill.standin_tx_id == null && bill.journal_entry_id ? [{ ...bill, home: "2100", left_cents: BigInt(bill.amount_cents) - cleared().reduce((s, c) => s + c.amount_cents, 0n) }] : []],
		[/WHERE t\.statement_id = \$1 AND t\.status = 'new' AND t\.amount_cents > 0/, (_, [sid]) => cards.filter((c) => c.status === "new" && String(c.statement_id) === String(sid)).map((c) => ({ ...c }))],
		...rest,
	];
}

test("Create bill on a statement, Ledger 0.33: the card's payment row is posted as its own entry against the stand-in and linked to the bill's entry; no line is moved, a part amount is fine, and Unlink reverses it", async () => {
	const bill = { ...STATEMENT_BILL };
	const part = { ...CARD_ROW, amount_cents: 30000n, memo: "", fitid: "" };
	const rest = { ...CARD_ROW, id: 22n, date: "2026-03-25", amount_cents: 55000n, memo: "", fitid: "F22" };
	const bank = { ...ROW, description: "VISA PAYMENT", amount_cents: -85000n, suggested_code: "2000" };
	const o = ledger33();
	const payment = billPayment(bank, bill).map(([p, a]) => (/SELECT b\.id, b\.amount_cents FROM/.test(p.source) ? [p, () => [{ id: 3n, amount_cents: 85000n }]] : [p, a]));
	const { call, posted, related, reversed } = await start({ answers: standinBooks(bill, [part, rest], payment), ...o });
	const BILL_ENTRY = [["2000", "85000", "0"], ["2000-7", "0", "85000"]];

	// Create bill: Dr accounts payable (the stand-in) / Cr the card company's own account; its entry is unpaid.
	await call("POST /bills", { body: CREATE });
	assert.deepEqual(shape(posted[0]), BILL_ENTRY);
	assert.deepEqual(o.tags.kept(100), ["unpaid"]);
	const status = await call("GET /status");
	assert.deepEqual([status.payables.statement_bills, status.payables.statement_bill_links], ["standin", "entry"]);

	// A row for the whole amount is offered under the row; a smaller one on the bill's page.
	const jm = await call("GET /statements/:id/journal-matches", { params: { id: "12" } });
	assert.deepEqual(jm.bills.map((m) => [String(m.transaction_id), String(m.bill.id)]), [], "30000 and 55000: neither is the whole 85000");
	let page = await call("GET /bills/:id", { params: { id: "3" } });
	assert.deepEqual([page.bill.standin.mode, page.bill.standin.can_link, page.bill.standin.left_cents], ["entry", true, 85000n]);
	assert.deepEqual(page.bill.standin.candidates.map((t) => [String(t.id), t.partial]), [["21", true], ["22", true]]);

	// A person links the part payment: the row is posted as its own entry, Dr the card / Cr accounts payable.
	await call("POST /bills/:id/link-statement-row", { params: { id: "3" }, body: { transaction_id: "21" } });
	assert.deepEqual(shape(posted[1]), [["2100", "30000", "0"], ["2000", "0", "30000"]]);
	assert.equal(posted[1].entity_id, undefined, "without the vendor: the accounts payable line is the stand-in, it must stay there");
	assert.equal(posted[1].entry_date, "2026-03-18", "on the row's own date");
	assert.deepEqual(posted[1].sent_links.map((l) => l.ref), ["tx:21", "bill:3"], "the entry opens the row and the bill from Ledger");
	assert.deepEqual([part.status, part.journal_entry_id, String(part.standin_bill_id), part.chosen_code], ["posted", 101, "3", "2000"]);
	assert.deepEqual(shape(o.entries.get(100)), BILL_ENTRY, "the bill's entry stays as posted");
	assert.equal(o.moves.length, 0, "no line is moved");
	assert.equal(bill.standin_tx_id, null);
	// The two entries show each other in Ledger: a plain link with a note, not a payment (the vendor isn't paid twice).
	assert.equal(related.length, 1);
	assert.deepEqual(related[0].slice(0, 2), [100, 101]);
	assert.match(related[0][2], /clears the stand-in.*not counted as money paid/);
	assert.equal(o.payments.links.length, 0);
	assert.deepEqual(o.tags.kept(100), ["unpaid"]);
	assert.equal(o.books.owed(7), 85000n);
	page = await call("GET /bills/:id", { params: { id: "3" } });
	assert.deepEqual([page.bill.standin.rows.map((t) => [String(t.id), t.journal_entry_id]), page.bill.standin.left_cents], [[["21", 101]], 55000n]);
	// The rest is now offered under its row, and no more than what still stands in can be linked.
	assert.deepEqual((await call("GET /statements/:id/journal-matches", { params: { id: "12" } })).bills.map((m) => [String(m.transaction_id), m.bill.left_cents]), [["22", 55000n]]);
	rest.amount_cents = 60000n;
	await assert.rejects(call("POST /bills/:id/link-statement-row", { params: { id: "3" }, body: { transaction_id: "22" } }), (e) => e.status === 422 && /more than the 550\.00/.test(e.message));
	rest.amount_cents = 55000n;
	await call("POST /bills/:id/link-statement-row", { params: { id: "3" }, body: { transaction_id: "22" } });
	assert.deepEqual(shape(posted[2]), [["2100", "55000", "0"], ["2000", "0", "55000"]]);
	assert.equal(posted[2].reference, "F22");
	page = await call("GET /bills/:id", { params: { id: "3" } });
	assert.deepEqual([page.bill.standin.left_cents, page.bill.standin.can_link], [0n, false]);
	await assert.rejects(call("POST /bills/:id/link-statement-row", { params: { id: "3" }, body: { transaction_id: "21" } }), (e) => e.status === 409);

	// Unlink one row: its own entry is reversed, the link goes, the row waits to be posted again; the bill's entry isn't touched.
	await call("POST /bills/:id/unlink-statement-row", { params: { id: "3" }, body: { transaction_id: "22" } });
	assert.deepEqual(reversed, [102]);
	assert.deepEqual([rest.status, rest.journal_entry_id, rest.standin_bill_id], ["new", null, null]);
	assert.deepEqual(related.map((r) => r.slice(0, 2)), [[100, 101]]);
	assert.deepEqual(shape(o.entries.get(100)), BILL_ENTRY);
	assert.equal(o.moves.length, 0);
	await assert.rejects(call("POST /bills/:id/unlink-statement-row", { params: { id: "3" }, body: { transaction_id: "22" } }), (e) => e.status === 409);

	// The payment from the bank pays the vendor: linked to the bill's entry as its payment, which Ledger tags paid.
	await call("POST /statements/:id/post", { params: { id: "1" }, body: {} });
	assert.deepEqual(shape(posted[3]), [["1000", "0", "85000"], ["2000-7", "85000", "0"]]);
	assert.deepEqual(linkCalls(o.payments), [[100, posted[3].id, 85000n]]);
	assert.deepEqual([bill.status, o.tags.kept(100), o.books.owed(7)], ["paid", ["paid"], 0n]);
	assert.deepEqual(shape(o.entries.get(100)), BILL_ENTRY);
});

test("stand-in bill, Ledger 0.33: undoing the approval reverses the rows' entries and the bill's; a bill linked the 0.29.0 way keeps working and its line can still be moved back", async () => {
	const bill = { ...STATEMENT_BILL };
	const card = { ...CARD_ROW, memo: "", fitid: "" };
	const o = ledger33();
	const { call, posted, reversed, related } = await start({ answers: standinBooks(bill, [card]), ...o });
	await call("POST /bills", { body: CREATE });
	// The whole amount is offered under the row, and linked there.
	assert.deepEqual((await call("GET /statements/:id/journal-matches", { params: { id: "12" } })).bills.map((m) => String(m.transaction_id)), ["21"]);
	await call("POST /bills/:id/link-statement-row", { params: { id: "3" }, body: { transaction_id: "21" } });
	assert.deepEqual(shape(posted[1]), [["2100", "85000", "0"], ["2000", "0", "85000"]]);
	await call("POST /bills/:id/unapprove", { params: { id: "3" } });
	assert.deepEqual(reversed, [101, 100], "the row's entry, then the bill's");
	assert.deepEqual([card.status, card.journal_entry_id], ["new", null]);
	assert.deepEqual([bill.status, bill.journal_entry_id, bill.payments_linked_at], ["new", null, null]);
	assert.deepEqual([related, o.tags.kept(100), o.moves.length], [[], [], 0]);

	// Linked by 0.29.0: the stand-in line sits in the card account and the row is settled by the bill's entry.
	const old = { ...STATEMENT_BILL, status: "open", vendor: "Visa", amount_cents: 85000n, account_code: "2000", standin_account_code: "2000", standin_line: 1, standin_tx_id: 21n, ap_account: "2000", journal_entry_id: 50, source: "statement", tags_synced_at: new Date(), payments_linked_at: new Date() };
	const row = { ...CARD_ROW, status: "posted", journal_entry_id: 50, memo: "", fitid: "" };
	const p = ledger33();
	p.entries.set(50, { id: 50, entry_date: "2026-03-01", description: "Visa bill", reversed_by_id: null, reverses_id: null, links: [{ module_id: "categorizer" }], lines: [{ line_number: 1, account_code: "2100", debit_cents: 85000n, credit_cents: 0n }, { line_number: 2, account_code: p.books.own(7, "vendor").code, debit_cents: 0n, credit_cents: 85000n }], moves: [{ line: 1, from: "2000", to: "2100" }] });
	const b = await start({ answers: [...refreshed(old), ...standinBooks(old, [row])], ...p });
	await b.call("POST /sort-now");
	assert.deepEqual(shape(p.entries.get(50)), [["2100", "85000", "0"], ["2000-7", "0", "85000"]], "nothing is rewritten at startup or by a sync");
	assert.equal(p.moves.length, 0);
	const page = await b.call("GET /bills/:id", { params: { id: "3" } });
	assert.deepEqual([page.bill.standin.mode, String(page.bill.standin.linked.id)], ["move", "21"]);
	await assert.rejects(b.call("POST /bills/:id/link-statement-row", { params: { id: "3" }, body: { transaction_id: "21" } }), (e) => e.status === 409 && /earlier way/.test(e.message));
	// Unlink moves the line back, as it did.
	await b.call("POST /bills/:id/unlink-statement-row", { params: { id: "3" } });
	assert.deepEqual(shape(p.entries.get(50)), [["2000", "85000", "0"], ["2000-7", "0", "85000"]]);
	assert.deepEqual([row.status, row.journal_entry_id, old.standin_tx_id, p.moves.length, b.reversed.length], ["new", null, null, 1, 0]);
	// Linked again, it is the new way: its own entry, no move.
	await b.call("POST /bills/:id/link-statement-row", { params: { id: "3" }, body: { transaction_id: "21" } });
	assert.deepEqual(shape(b.posted[0]), [["2100", "85000", "0"], ["2000", "0", "85000"]]);
	assert.deepEqual([p.moves.length, old.standin_tx_id, shape(p.entries.get(50))[0][0]], [1, null, "2000"]);
});

test("the backfill links the payments posted before 0.30.0 to their bills' entries with their amounts, once; it posts, reverses and moves nothing", async () => {
	// Paid by two statement rows in 0.29.0: tagged paid by the module, nothing linked in Ledger.
	const bill = { ...BILL, status: "paid", due_date: "2999-01-01", journal_entry_id: 50, paid_entry_id: 61, ap_account: "2000", tags_synced_at: new Date(), payments_linked_at: null };
	const o = ledger33();
	const own = o.books.own(7, "vendor").code;
	const cust = o.books.own(4, "customer").code;
	o.entries.set(50, payableEntry(50, own));
	const pay = (id, cents, to = own) => ({ id, entry_date: "2026-03-15", description: "HYDRO ONE", reversed_by_id: null, reverses_id: null, links: [{ module_id: "categorizer" }], lines: [{ account_code: "1000", debit_cents: 0n, credit_cents: cents }, { account_code: to, debit_cents: cents, credit_cents: 0n }] });
	o.entries.set(60, pay(60, 3000n));
	o.entries.set(61, pay(61, 7000n)); // 5550 of it paid the bill, 1450 was split off elsewhere
	o.entries.set(62, pay(62, 999n, "5100")); // a row matched to the bill but booked to another account: not its payment
	// A deposit that paid a Sales invoice in 0.29.0.
	o.entries.set(10, { ...invoice(10, 50000n, []), lines: [{ account_code: cust, debit_cents: 50000n, credit_cents: 0n }, { account_code: "4000", debit_cents: 0n, credit_cents: 50000n }] });
	o.entries.set(70, { id: 70, entry_date: "2026-03-16", description: "E-TRANSFER", reversed_by_id: null, reverses_id: null, links: [{ module_id: "categorizer" }], lines: [{ account_code: "1000", debit_cents: 50000n, credit_cents: 0n }, { account_code: cust, debit_cents: 0n, credit_cents: 50000n }] });
	await o.tags.setAs("categorizer", 50, "paid", { note: "payment in entry #61" });
	await o.tags.setAs("categorizer", 10, "paid", { note: "paid by entry #70" });
	const state = new Set();
	const answers = [
		[/FROM mod_categorizer\.bills WHERE journal_entry_id IS NOT NULL AND payments_linked_at IS NULL/, () => (bill.payments_linked_at ? [] : [{ ...bill }])],
		[/AS share_cents FROM mod_categorizer\.transactions/, () => [{ id: 7n, journal_entry_id: 60n, share_cents: 3000n }, { id: 8n, journal_entry_id: 61n, share_cents: 5550n }, { id: 9n, journal_entry_id: 62n, share_cents: 999n }]],
		[/SELECT 1 FROM mod_categorizer\.module_state WHERE key = 'payment_links'/, () => (state.has("payment_links") ? [{}] : [])],
		[/INSERT INTO mod_categorizer\.module_state \(key, value\) VALUES \('payment_links'/, () => void state.add("payment_links")],
		[/SELECT DISTINCT pays_entry_id, journal_entry_id, abs\(amount_cents\)/, () => [{ pays_entry_id: 10n, journal_entry_id: 70n, amount_cents: 50000n }]],
		...billTable(bill),
	];
	const before = [...o.entries.values()].map(shape);
	const a = await start({ answers, ...o });
	assert.deepEqual(linkCalls(o.payments), [[50, 60, 3000n], [50, 61, 5550n], [10, 70, 50000n]]);
	assert.ok(bill.payments_linked_at);
	assert.deepEqual([bill.status, o.tags.kept(50), o.tags.kept(10)], ["paid", ["paid"], ["paid"]]);
	assert.deepEqual([a.posted.length, a.reversed.length, o.moves.length], [0, 0, 0]);
	assert.deepEqual([...o.entries.values()].map(shape), before, "no entry changed");
	const page = await a.call("GET /bills/:id", { params: { id: "3" } });
	assert.deepEqual([page.bill.payment_status, page.bill.payments_from, page.bill.due_cents], ["paid", "ledger", 8550n]);
	// Run again (the next start): nothing more is linked.
	const calls = o.payments.calls.length;
	const log = o.tags.log.length;
	await start({ answers, ...o });
	assert.equal(o.payments.calls.length, calls);
	assert.equal(o.tags.log.length, log);

	// An approved bill paid in part before: Ledger tags it partially paid, and the Bills tab says the same.
	const open = { ...BILL, status: "open", due_date: "2999-01-01", journal_entry_id: 50, ap_account: "2000", tags_synced_at: new Date(), payments_linked_at: null };
	const p = ledger33();
	const own2 = p.books.own(7, "vendor").code;
	p.entries.set(50, payableEntry(50, own2));
	p.entries.set(60, { ...pay(60, 3000n), lines: [{ account_code: "1000", debit_cents: 0n, credit_cents: 3000n }, { account_code: own2, debit_cents: 3000n, credit_cents: 0n }] });
	const b = await start({
		answers: [
			[/FROM mod_categorizer\.bills WHERE journal_entry_id IS NOT NULL AND payments_linked_at IS NULL/, () => (open.payments_linked_at ? [] : [{ ...open }])],
			[/AS share_cents FROM mod_categorizer\.transactions/, () => [{ id: 7n, journal_entry_id: 60n, share_cents: 3000n }]],
			[/AS posted_cents\s+FROM mod_categorizer\.bills b LEFT JOIN/, () => [{ ...open, posted_cents: 3000n }]],
			...billTable(open),
		],
		...p,
	});
	assert.deepEqual([p.tags.kept(50), open.status], [["partially_paid"], "open"]);
	const list = await b.call("GET /bills", { query: "status=unpaid" });
	assert.deepEqual(list.data.map((x) => [x.payment_status, x.paid_cents, x.left_cents, x.payments_from, "posted_cents" in x]), [["partially_paid", 3000n, 5550n, "ledger", false]]);
});

test("without ctx.ledger.linkPayment (Ledger before 0.33.0) payments and tags are kept as 0.29.0 did, and partly paid bills show what the module's rows say", async () => {
	const bill = { ...BILL, status: "open", due_date: "2999-01-01", journal_entry_id: 50, ap_account: "2000", tags_synced_at: new Date() };
	const o = { ...ownBooks(), moveLine: true, moves: [] };
	o.entries.set(50, payableEntry(50, o.books.own(7, "vendor").code));
	const row = { ...ROW, description: "HYDRO ONE", amount_cents: -3000n, suggested_code: "2000" };
	const answers = [[/AS posted_cents\s+FROM mod_categorizer\.bills b LEFT JOIN/, () => [{ ...bill, posted_cents: 3000n }]], ...billPayment(row, bill)].map(([p, a]) => (/AS linked,/.test(p.source) ? [p, () => [{ linked: "3000", posted: "3000" }]] : [p, a]));
	const { call, posted, related } = await start({ answers: [...refreshed(bill), ...answers], ...o });
	const status = await call("GET /status");
	assert.deepEqual([status.payables.linked_payments, status.payables.statement_bill_links], [false, "move"]);
	await call("POST /sort-now");
	assert.deepEqual(o.tags.kept(50), [], "no unpaid tag on an older Ledger");
	await call("POST /statements/:id/post", { params: { id: "1" }, body: {} });
	assert.equal(posted.length, 1);
	assert.deepEqual([bill.status, o.tags.kept(50), related], ["open", [], []], "a part payment: the bill stays open, as before");
	assert.equal(bill.payments_linked_at, undefined);
	const list = await call("GET /bills", { query: "status=unpaid" });
	assert.deepEqual(list.data.map((x) => [x.payment_status, x.paid_cents, x.left_cents, x.payments_from]), [["partially_paid", 3000n, 5550n, "module"]]);
	const page = await call("GET /bills/:id", { params: { id: "3" } });
	assert.deepEqual([page.bill.payment_status, page.bill.paid_cents, page.bill.left_cents, page.bill.payments_from], ["partially_paid", 3000n, 5550n, "module"]);
});

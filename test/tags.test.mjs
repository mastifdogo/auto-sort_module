// Ledger's shared tags on journal entries (ctx.tags, Ledger 0.23.0): what Auto sort sets on a
// bill's entry, what it does when someone else tags that entry, and rows that pay tagged entries.
// The routes run against a stand-in ctx whose `tags` keeps them in memory, like Ledger's.

import assert from "node:assert/strict";
import { test } from "node:test";
import register from "../server.mjs";
import { assignPayables, payableCandidates } from "../lib/tags.mjs";

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
		/** What Ledger does to an entry posted with a customer or vendor: its receivable or payable lines go to their own account. */
		route: (entry) =>
			!entry.entity_id ? entry.lines : entry.lines.map((l) => {
				const a = account(l.account_code);
				const role = a && !a.entity ? Object.keys(KIND).find((r) => KIND[r] === a.kind) : null;
				return role ? { ...l, account_code: own(entry.entity_id, role, a.currency, a.code).code } : l;
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
 * change. With books (Ledger 0.31.0): "customer" and "vendor" are read from the accounts, setting
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
		byEntry.set(id, [...stored(id), { tag, entity: entity_id ? { id: entity_id, name: `Entity ${entity_id}` } : null, note: opts.note ?? "", module_id: by, set_by: user?.username ?? null }]);
		await announce({ entry_id: id, action: "set", tag, entity_id, module_id: by });
		if (tag === "paid") await removeAs(by, id, "overdue");
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
			standard: ["paid", "billed", "overdue", "customer", "vendor"],
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
async function start({ answers = [], tags = fakeTags(), entries = new Map(), settings = {}, accounts = ACCOUNTS, books = null, entities = {} } = {}) {
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
				const e = { ...entry, lines: (books ? books.route(entry) : entry.lines).map((l) => ({ ...l })), id: 100 + posted.length, entity: entry.entity_id ? { id: entry.entity_id, name: "" } : null, reversed_by_id: null, reverses_id: null, links: [{ module_id: "categorizer" }] };
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
				return { id: Number(id) + 1000 };
			},
			linkJournalEntry: async () => ({}),
			unlinkJournalEntry: async () => true,
			clearingAccount: async ({ key, currency }) => ({ ...CLEARING, module_key: key, currency }),
			relateEntries: async (a, b, opts) => { related.push([Number(a), Number(b), opts.note]); return []; },
		},
		dashboard: Object.fromEntries(["notify", "todo", "complete", "remove"].map((call) => [call, async () => {}])),
		orgs: { forEach: async (fn) => fn({ id: 1 }), current: async () => ({ id: 1, name: "Main", kind: "business" }), list: async () => [] },
		files: { onReceive() {}, inbox: async () => [] },
		search: { provide() {} },
		...(tags ? { tags: tags.api } : {}),
		// Ledger's list of customers and vendors, with their own accounts on Ledger 0.31.0.
		...(books ? { entities: { find: async () => null, list: async () => [], ensure: async (name) => ({ id: entities[name] ?? 99, name }), account: async (id, role, currency) => books.own(id, role, currency) } } : {}),
	};
	await register(ctx);
	// The startup backfill isn't awaited by register.
	await new Promise((r) => setImmediate(r));
	const call = (route, { params = {}, body, query = "" } = {}) =>
		routes.get(route)({ params, body, query: new URLSearchParams(query), user: { username: "pat", role: "bookkeeper" } });
	return { call, posted, tags, entries, related, reversed };
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

test("Create bill on a statement: an unpaid bill at once, Dr Auto sort's clearing account / Cr accounts payable", async () => {
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

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

/** ctx.tags as Ledger has it: tags per entry, "paid" takes "overdue" off, listeners hear every change. */
function fakeTags(entries = new Map()) {
	const byEntry = new Map();
	const listeners = [];
	const log = [];
	const list = (id) => byEntry.get(Number(id)) ?? [];
	const announce = async (c) => {
		log.push(c);
		for (const fn of listeners) await fn(c);
	};
	/** by: a module id, or null for a person. */
	async function setAs(by, entryId, tag, opts = {}, user) {
		const id = Number(entryId);
		const entity_id = opts.entity_id ?? null;
		if ((tag === "customer" || tag === "vendor") && !entity_id) throw new HttpError(422, "entity_id is required");
		if (list(id).some((t) => t.tag === tag && (t.entity?.id ?? null) === entity_id)) return list(id);
		byEntry.set(id, [...list(id), { tag, entity: entity_id ? { id: entity_id, name: `Entity ${entity_id}` } : null, note: opts.note ?? "", module_id: by, set_by: user?.username ?? null }]);
		await announce({ entry_id: id, action: "set", tag, entity_id, module_id: by });
		if (tag === "paid") await removeAs(by, id, "overdue");
		return list(id);
	}
	async function removeAs(by, entryId, tag, opts = {}) {
		const id = Number(entryId);
		const gone = list(id).filter((t) => t.tag === tag && (!opts.entity_id || t.entity?.id === opts.entity_id));
		byEntry.set(id, list(id).filter((t) => !gone.includes(t)));
		for (const g of gone) await announce({ entry_id: id, action: "removed", tag, entity_id: g.entity?.id ?? null, module_id: by });
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
async function start({ answers = [], tags = fakeTags(), entries = new Map(), settings = {}, accounts = ACCOUNTS } = {}) {
	const routes = new Map();
	const posted = [];
	const related = [];
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
				const e = { ...entry, id: 100 + posted.length, entity: entry.entity_id ? { id: entry.entity_id, name: "" } : null, reversed_by_id: null, reverses_id: null, links: [{ module_id: "categorizer" }] };
				posted.push(e);
				entries.set(e.id, e);
				return e;
			},
			getJournalEntry: async (id) => {
				if (!entries.has(Number(id))) throw new HttpError(404, "not found");
				return { ...entries.get(Number(id)), tags: tags ? tags.list(id) : undefined };
			},
			reverseJournalEntry: async (id) => ({ id: Number(id) + 1000 }),
			linkJournalEntry: async () => ({}),
			clearingAccount: async ({ key, currency }) => ({ ...CLEARING, module_key: key, currency }),
			relateEntries: async (a, b, opts) => { related.push([Number(a), Number(b), opts.note]); return []; },
		},
		dashboard: Object.fromEntries(["notify", "todo", "complete", "remove"].map((call) => [call, async () => {}])),
		orgs: { forEach: async (fn) => fn({ id: 1 }), current: async () => ({ id: 1, name: "Main", kind: "business" }), list: async () => [] },
		files: { onReceive() {}, inbox: async () => [] },
		search: { provide() {} },
		...(tags ? { tags: tags.api } : {}),
	};
	await register(ctx);
	// The startup backfill isn't awaited by register.
	await new Promise((r) => setImmediate(r));
	const call = (route, { params = {}, body, query = "" } = {}) =>
		routes.get(route)({ params, body, query: new URLSearchParams(query), user: { username: "pat", role: "bookkeeper" } });
	return { call, posted, tags, entries, related };
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

// The routes, run against a stand-in for Ledger's ctx: the database answers from a list of
// [pattern, answer] pairs (anything else finds nothing), so each test states the rows it needs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import register from "../server.mjs";

class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

/** Registers the module on a fake ctx. answers: [[RegExp, (sql, params) => rows | { rows, rowCount }]]. */
async function start({ answers = [], ledger = {} } = {}) {
	const routes = new Map();
	const dashboard = [];
	const none = { rows: [], rowCount: 0 };
	const ctx = {
		id: "categorizer",
		name: "Auto sort",
		version: "0.0.0",
		ledgerVersion: "0.0.0",
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
		settings: { get: async () => ({}), set: async () => {}, onChange() {} },
		llm: { status: async () => ({ configured: false }), json: async () => { throw new HttpError(409, "not set up"); } },
		ledger: { listAccounts: async () => [], ...ledger },
		dashboard: Object.fromEntries(["notify", "todo", "complete", "remove"].map((call) => [call, async (...args) => dashboard.push([call, ...args])])),
		orgs: { forEach: async (fn) => fn({ id: 1 }), current: async () => ({ id: 1, name: "Main", kind: "business" }), list: async () => [] },
		files: { onReceive() {}, inbox: async () => [] },
		search: { provide() {} },
	};
	await register(ctx);
	const call = (route, { params = {}, body, query = "" } = {}) =>
		routes.get(route)({ params, body, query: new URLSearchParams(query), user: { username: "pat", role: "bookkeeper" } });
	return { call, dashboard };
}

const STATEMENT = [/FROM mod_categorizer\.statements s LEFT JOIN mod_categorizer\.transactions t/, () => [{ id: 1n, filename: "july.csv", account_code: "1000", posted: 0 }]];
const NO_MATCHES_LEFT = [/count\(\*\)::int AS n FROM mod_categorizer\.match_suggestions/, () => [{ n: 0 }]];

test("a row whose entry is posted stays posted when a later step fails, and isn't posted twice", async () => {
	const row = { status: "new" };
	const entries = [];
	const { call } = await start({
		ledger: { createJournalEntry: async (entry) => ({ id: entries.push(entry) }), linkJournalEntry: async () => ({}) },
		answers: [
			STATEMENT,
			NO_MATCHES_LEFT,
			[/SELECT id FROM mod_categorizer\.transactions\s+WHERE statement_id = \$1 AND status = 'new'/, () => (row.status === "new" ? [{ id: 7n }] : [])],
			[/SET status = 'posting' WHERE id = \$1 AND status = 'new'/, () => {
				if (row.status !== "new") return [];
				row.status = "posting";
				return [{ date: "2026-07-02", description: "METRO GROCERY", memo: "", amount_cents: -2000n, fitid: "", account_code: "1000", code: "5000", bill_id: null, statement_id: 1n, transfer_tx_id: null, transfer_entry_id: null }];
			}],
			[/SET status = 'posted', journal_entry_id = \$2/, () => { row.status = "posted"; }],
			// Learning the payee rule fails after the entry is in the journal.
			[/INSERT INTO mod_categorizer\.rules/, () => { throw new Error("rules table is locked"); }],
			[/SET status = 'new', error = \$2 WHERE id = \$1/, (sql) => {
				if (/AND status = 'posting'/.test(sql) && row.status !== "posting") return { rows: [], rowCount: 0 };
				row.status = "new";
				return { rows: [], rowCount: 1 };
			}],
		],
	});
	const first = await call("POST /statements/:id/post", { params: { id: "1" }, body: {} });
	assert.deepEqual(first, { posted: 1, already_recorded: 0, failed: [] });
	assert.equal(row.status, "posted");
	const again = await call("POST /statements/:id/post", { params: { id: "1" }, body: {} });
	assert.equal(again.posted, 0);
	assert.equal(entries.length, 1, "one journal entry for one bank line");
	assert.deepEqual(entries[0].lines.map((l) => [l.account_code, l.debit_cents, l.credit_cents]), [["1000", 0n, 2000n], ["5000", 2000n, 0n]]);
});

test("a row that fails before its entry is posted goes back to be posted again", async () => {
	const row = { status: "new" };
	const { call } = await start({
		ledger: { createJournalEntry: async () => { throw new Error("account 5000 is inactive"); } },
		answers: [
			STATEMENT,
			NO_MATCHES_LEFT,
			[/SELECT id FROM mod_categorizer\.transactions\s+WHERE statement_id = \$1 AND status = 'new'/, () => [{ id: 7n }]],
			[/SET status = 'posting' WHERE id = \$1 AND status = 'new'/, () => {
				row.status = "posting";
				return [{ date: "2026-07-02", description: "METRO GROCERY", memo: "", amount_cents: -2000n, fitid: "", account_code: "1000", code: "5000", bill_id: null, statement_id: 1n, transfer_tx_id: null, transfer_entry_id: null }];
			}],
			[/SET status = 'new', error = \$2 WHERE id = \$1/, () => { row.status = "new"; return { rows: [], rowCount: 1 }; }],
		],
	});
	const r = await call("POST /statements/:id/post", { params: { id: "1" }, body: {} });
	assert.deepEqual(r, { posted: 0, already_recorded: 0, failed: [{ id: 7n, error: "account 5000 is inactive" }] });
	assert.equal(row.status, "new");
});

test("a row can't be booked against its statement's own account", async () => {
	const { call } = await start({
		ledger: { listAccounts: async () => [{ code: "1000" }, { code: "5000" }] },
		answers: [
			NO_MATCHES_LEFT,
			[/SELECT 1 FROM mod_categorizer\.transactions WHERE id = ANY\(\$1::bigint\[\]\) AND account_code = \$2/, (_, [, code]) => (code === "1000" ? [{}] : [])],
			[/UPDATE mod_categorizer\.transactions SET chosen_code = \$2/, () => ({ rows: [{ statement_id: 1n }], rowCount: 1 })],
		],
	});
	await assert.rejects(call("POST /transactions/bulk", { body: { ids: [7], account_code: "1000" } }), { status: 422 });
	assert.deepEqual(await call("POST /transactions/bulk", { body: { ids: [7], account_code: "5000" } }), { updated: 1 });
});

test("a row isn't merged into a reversed journal entry", async () => {
	let merged = false;
	const { call } = await start({
		ledger: { getJournalEntry: async (id) => ({ id, reversed_by_id: id === 5 ? 6 : null, reverses_id: null, lines: [{ account_code: "1000" }] }), linkJournalEntry: async () => ({}) },
		answers: [
			NO_MATCHES_LEFT,
			[/FROM mod_categorizer\.transactions t JOIN mod_categorizer\.statements s ON s\.id = t\.statement_id WHERE t\.id = \$1/, () => [{ id: 7n, statement_id: 1n, account_code: "1000", amount_cents: -2000n, status: "new", chosen_code: null, bill_id: null, transfer_tx_id: null, duplicate_entry_id: null, description: "METRO", filename: "july.csv" }]],
			[/SET status = 'merged'/, () => { merged = true; return { rows: [], rowCount: 1 }; }],
		],
	});
	await assert.rejects(call("POST /duplicates/merge", { body: { merge_id: 7, entry_id: 5 } }), { status: 409 });
	assert.equal(merged, false);
	assert.equal((await call("POST /duplicates/merge", { body: { merge_id: 7, entry_id: 4 } })).entry_id, 4);
});

test("a payment isn't matched to a bill that is paid or ignored", async () => {
	let status = "ignored";
	let matched = 0;
	const { call } = await start({
		answers: [
			[/FROM mod_categorizer\.bills b LEFT JOIN mod_categorizer\.bill_documents d ON d\.bill_id = b\.id WHERE b\.id = \$1/, () => [{ id: 3n, kind: "bill", status, vendor: "Hydro One", account_code: "5100", ap_account: null, paid_entry_id: null }]],
			[/SET bill_id = \$2, chosen_code = \$3/, () => { matched++; return { rows: [], rowCount: 1 }; }],
		],
	});
	await assert.rejects(call("POST /bills/:id/match", { params: { id: "3" }, body: { transaction_id: 7 } }), { status: 409 });
	assert.equal(matched, 0);
	status = "open";
	await call("POST /bills/:id/match", { params: { id: "3" }, body: { transaction_id: 7 } });
	assert.equal(matched, 1);
});

test("discarding a statement clears the Auto sort to-do when none of its matches are left", async () => {
	const { call, dashboard } = await start({ answers: [STATEMENT, NO_MATCHES_LEFT] });
	await call("DELETE /statements/:id", { params: { id: "1" } });
	assert.ok(dashboard.some(([what, key]) => what === "complete" && key === "match-suggestions"));
});

// The page's script isn't a module: take the one function out of ui/index.html and run it.
test("the bill page saves with one request (Mark paid, Ignore, Reopen and Save used to call a route that doesn't exist)", async () => {
	const html = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8");
	const source = /\tasync function billAction\([\s\S]*?\n\t}\n/.exec(html)[0];
	const calls = [];
	const errors = [];
	const billAction = new Function("api", "currentBill", "loadBills", "openBill", "fail", "$", `let customersLoaded = true;\n${source}\nreturn billAction;`)(
		async (path, opts) => {
			calls.push(`${opts.method} ${path}`);
			if (opts.method !== "PATCH" && !/\/(approve|unapprove|match|unmatch|link-entry|unlink-entry)$/.test(path)) throw new Error("no such endpoint");
			return { id: 1 };
		},
		{ id: 1 },
		async () => {},
		async () => {},
		(e) => errors.push(e.message),
		() => ({ classList: { add() {} } }),
	);
	assert.deepEqual(await billAction("save", { status: "paid" }), { id: 1 });
	assert.deepEqual(await billAction("save", { vendor: "Hydro One" }), { id: 1 });
	assert.deepEqual(await billAction("approve"), { id: 1 });
	assert.deepEqual(calls, ["PATCH /bills/1", "PATCH /bills/1", "POST /bills/1/approve"]);
	assert.deepEqual(errors, []);
});

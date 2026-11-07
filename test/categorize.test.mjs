import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrompt, candidateAccounts, examplesFromEntries, suggest } from "../lib/categorize.mjs";

const bank = { code: "1000", name: "Chequing", type: "asset", currency: "CAD", is_active: true };
const accounts = [
	bank,
	{ code: "5100", name: "Fuel", type: "expense", currency: "CAD", is_active: true, description: "" },
	{ code: "5200", name: "Subscriptions", type: "expense", currency: "CAD", is_active: true, description: "" },
	{ code: "4000", name: "Salary", type: "revenue", currency: "CAD", is_active: true, description: "" },
	{ code: "5900", name: "Old", type: "expense", currency: "CAD", is_active: false, description: "" },
	{ code: "1100", name: "USD account", type: "asset", currency: "USD", is_active: true, description: "" },
];
const candidates = candidateAccounts(accounts, bank);

/** A fake ctx.llm.json that records requests; answer(prompt) gives the results rows. */
function fakeLlm(answer) {
	const calls = [];
	const llm = async (req) => {
		calls.push(req);
		return { data: { results: answer(req) }, model: "m" };
	};
	return { calls, llm };
}

const rowsOf = (req) => req.prompt.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));

test("candidate accounts: active, same currency, not the statement account", () => {
	assert.deepEqual(candidates.map((a) => a.code), ["5100", "5200", "4000"]);
});

test("rules answer without the model; the rest go to the AI with a constrained schema", async () => {
	const { calls, llm } = fakeLlm((req) => rowsOf(req).map((t) => ({ i: t.i, account_code: t.amount.startsWith("-") ? "5100" : "4000", confidence: 1.7, reason: "test" })));
	const out = await suggest({
		llm,
		statementAccount: bank,
		candidates,
		examples: [{ description: "NETFLIX.COM", amount: "-16.99", account_code: "5200" }],
		rules: new Map([["NETFLIX", { account_code: "5200", hits: 3 }]]),
		transactions: [
			{ id: 1, date: "2026-03-01", description: "NETFLIX.COM", memo: "", amount_cents: -1699n },
			{ id: 2, date: "2026-03-02", description: "SHELL #12", memo: "", amount_cents: -4510n },
			{ id: 3, date: "2026-03-03", description: "PAYROLL", memo: "", amount_cents: 200000n },
		],
	});
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].schema.properties.results.items.properties.account_code.enum, ["5100", "5200", "4000"]);
	assert.match(calls[0].prompt, /"NETFLIX.COM" -16.99 -> 5200/);
	assert.equal(rowsOf(calls[0]).length, 2); // the rule-matched row isn't sent
	assert.equal(out.get(1).source, "rule");
	assert.equal(out.get(1).code, "5200");
	assert.deepEqual(out.get(2), { code: "5100", confidence: 1, reason: "test", source: "llm" });
	assert.equal(out.get(3).code, "4000");
});

test("invalid codes and missing rows become errors; batches are split", async () => {
	const { calls, llm } = fakeLlm(() => [{ i: 1, account_code: "9999", confidence: 0.9, reason: "x" }]);
	const txs = [1, 2, 3].map((id) => ({ id, date: "2026-03-01", description: `X${id}`, memo: "", amount_cents: -100n }));
	const out = await suggest({ llm, statementAccount: bank, candidates, examples: [], rules: new Map(), transactions: txs, batchSize: 2 });
	assert.equal(calls.length, 2);
	for (const id of [1, 2, 3]) assert.equal(out.get(id).source, "error");
});

test("'not allowed' and 'not set up' from Ledger's AI stop after the first batch", async () => {
	for (const status of [403, 409]) {
		let n = 0;
		const llm = async () => {
			n++;
			throw Object.assign(new Error("this module isn't allowed to use AI; an admin can allow it under Settings → AI"), { status });
		};
		const txs = [1, 2, 3, 4].map((id) => ({ id, date: "2026-03-01", description: `X${id}`, memo: "", amount_cents: -100n }));
		const out = await suggest({ llm, statementAccount: bank, candidates, examples: [], rules: new Map(), transactions: txs, batchSize: 1 });
		assert.equal(n, 1);
		assert.match(out.get(4).reason, /Settings → AI/);
	}
});

test("a provider failure on one batch doesn't stop the others", async () => {
	let n = 0;
	const llm = async (req) => {
		if (n++ === 0) throw Object.assign(new Error("api.anthropic.com answered 529: overloaded"), { status: 502 });
		return { data: { results: rowsOf(req).map((t) => ({ i: t.i, account_code: "5100", confidence: 0.9, reason: "ok" })) } };
	};
	const txs = [1, 2].map((id) => ({ id, date: "2026-03-01", description: `X${id}`, memo: "", amount_cents: -100n }));
	const out = await suggest({ llm, statementAccount: bank, candidates, examples: [], rules: new Map(), transactions: txs, batchSize: 1 });
	assert.equal(out.get(1).source, "error");
	assert.equal(out.get(2).source, "llm");
});

test("examples come from two-line entries touching the statement account", () => {
	const line = (account_code, d, c) => ({ account_code, debit_cents: BigInt(d), credit_cents: BigInt(c) });
	const entries = [
		{ description: "SHELL #1", lines: [line("5100", 4000, 0), line("1000", 0, 4000)] },
		{ description: "SHELL #2", lines: [line("5100", 3000, 0), line("1000", 0, 3000)] },
		{ description: "Split", lines: [line("5100", 1, 0), line("5200", 1, 0), line("1000", 0, 2)] },
		{ description: "Inactive", lines: [line("5900", 1, 0), line("1000", 0, 1)] },
	];
	const ex = examplesFromEntries(entries, "1000", new Set(candidates.map((a) => a.code)));
	assert.deepEqual(ex, [{ description: "SHELL #1", amount: "-40.00", account_code: "5100" }]);
	const prompt = buildPrompt({ statementAccount: bank, candidates, examples: ex, batch: [{ i: 1, date: "2026-03-01", description: "A", memo: "", amount_cents: -5n }] });
	assert.match(prompt, /"amount":"-0.05"/);
});

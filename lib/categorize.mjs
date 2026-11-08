// Turns statement transactions into account suggestions.
//
// 1. A transaction whose payee matches a learned rule gets that rule's
//    account, without asking the model.
// 2. The rest go to Ledger's AI (ctx.llm.json) in batches. The prompt lists the chart of
//    accounts, the statement account, and examples of how you categorised
//    similar transactions before (learned rules and recent journal entries).
//    The answer is constrained to a JSON schema whose account codes are an
//    enum of your real accounts, so the model can't invent one.

import { payeeKey } from "./parse.mjs";

const MAX_EXAMPLES = 60;

/** Ledger's AI answers 409 when no provider is set up and 403 when this module isn't allowed. */
export const isSetupError = (err) => err?.status === 409 || err?.status === 403;

export function formatCents(c) {
	const neg = c < 0n;
	const a = neg ? -c : c;
	return `${neg ? "-" : ""}${a / 100n}.${String(a % 100n).padStart(2, "0")}`;
}

/** Accounts a statement's transactions can be booked against: active, same currency, not the statement account itself. */
export function candidateAccounts(accounts, statementAccount) {
	return accounts.filter((a) => a.is_active && a.currency === statementAccount.currency && a.code !== statementAccount.code);
}

/** The answer for "none of the accounts fits": the model proposes one to create. */
export const NEW = "NEW";
export const ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"];
const TYPE_START = { asset: 1000, liability: 2000, equity: 3000, revenue: 4000, expense: 5000 };

/**
 * A free code for a new account of this type, next to the chart's numbering: 10 past the highest
 * numeric code of that type (or the type's usual range, e.g. 5000 for expenses), skipping used codes.
 */
export function proposeCode(accounts, type, taken = new Set()) {
	const used = new Set([...accounts.map((a) => a.code), ...taken]);
	const same = accounts.filter((a) => a.type === type && /^\d+$/.test(a.code)).map((a) => Number(a.code));
	let n = same.length > 0 ? Math.floor(Math.max(...same) / 10) * 10 + 10 : (TYPE_START[type] ?? 9000);
	while (used.has(String(n))) n += 10;
	return String(n);
}

export function responseSchema(codes) {
	return {
		type: "object",
		properties: {
			results: {
				type: "array",
				items: {
					type: "object",
					properties: {
						i: { type: "integer", description: "the transaction's i" },
						account_code: { type: "string", enum: [...codes, NEW] },
						confidence: { type: "number", description: "0 to 1" },
						reason: { type: "string", description: "a few words" },
						new_account: {
							type: "object",
							description: `only with account_code "${NEW}": the account to create; otherwise an empty name`,
							properties: { name: { type: "string" }, type: { type: "string", enum: ACCOUNT_TYPES } },
							required: ["name", "type"],
							additionalProperties: false,
						},
					},
					required: ["i", "account_code", "confidence", "reason", "new_account"],
					additionalProperties: false,
				},
			},
		},
		required: ["results"],
		additionalProperties: false,
	};
}

const SYSTEM = `You are a careful bookkeeper. You assign each bank or credit-card statement transaction to the account in the user's chart of accounts it should be booked against (the other side of a double-entry journal entry; the statement account is always the first side).

How to decide:
- Use the merchant or payee in the description, the memo, the sign and the size of the amount.
- Follow the user's own past choices in the examples whenever the payee matches; they show the user's conventions.
- Positive amounts are money coming into the statement account (income, refunds, transfers in, loan proceeds); negative amounts are money going out (expenses, transfers out, card or loan payments).
- Transfers between the user's own accounts (credit-card payments, savings transfers) go to that asset or liability account, not to an expense.
- Only use account codes from the list. If none of them fits (you would otherwise pick a vague catch-all and guess), answer account_code "NEW" with new_account: a short name in the style of the chart (e.g. "Pet care", "Software subscriptions") and its type. The user reviews it before it is created. Otherwise give new_account an empty name.

confidence is your probability that a careful bookkeeper would choose the same account: 0.9 or more only when the payee is unambiguous or matches an example; below 0.6 when you are guessing (generic descriptions like "POS PURCHASE 4411", e-transfers to people, cash withdrawals). reason is at most 12 words, e.g. "Shell gas station" or "matches past Netflix entries".`;

export function buildPrompt({ statementAccount, candidates, examples, batch }) {
	const accountLines = candidates.map((a) => `${a.code} | ${a.name} | ${a.type}${a.description ? ` | ${a.description.slice(0, 120)}` : ""}`);
	const exampleLines = examples.slice(0, MAX_EXAMPLES).map((e) => `${JSON.stringify(e.description)} ${e.amount ?? ""} -> ${e.account_code}`.replace("  ", " "));
	const txLines = batch.map((t) =>
		JSON.stringify({ i: t.i, date: t.date, description: t.description, ...(t.memo ? { memo: t.memo } : {}), amount: formatCents(t.amount_cents) }),
	);
	return [
		`Statement account: ${statementAccount.code} | ${statementAccount.name} | ${statementAccount.type} | ${statementAccount.currency}`,
		"",
		"Chart of accounts (code | name | type | description):",
		...accountLines,
		"",
		exampleLines.length > 0 ? "How the user categorised similar transactions before:" : "There are no past examples yet.",
		...exampleLines,
		"",
		`Categorise each of these ${batch.length} transactions. Return one result per transaction, using its i:`,
		...txLines,
	].join("\n");
}

/**
 * Examples from the books: two-line journal entries that touch the statement
 * account, as description -> the other account. Newest first, one per payee.
 */
export function examplesFromEntries(entries, statementCode, allowed) {
	const seen = new Set();
	const out = [];
	for (const e of entries) {
		if (e.lines.length !== 2 || !e.lines.some((l) => l.account_code === statementCode)) continue;
		const other = e.lines.find((l) => l.account_code !== statementCode);
		if (!other || !allowed.has(other.account_code)) continue;
		const key = payeeKey(e.description) || e.description;
		if (seen.has(key)) continue;
		seen.add(key);
		const mine = e.lines.find((l) => l.account_code === statementCode);
		out.push({ description: e.description, amount: formatCents(BigInt(mine.debit_cents) - BigInt(mine.credit_cents)), account_code: other.account_code });
	}
	return out;
}

/**
 * Suggests an account for each transaction.
 *
 * transactions: [{ id, date, description, memo, amount_cents }]
 * rules: Map(payee_key -> { account_code, hits })
 * Returns Map(id -> { code, confidence, reason, source })
 */
export async function suggest({ llm, statementAccount, candidates, examples, rules, transactions, batchSize = 40, onProgress }) {
	const allowed = new Set(candidates.map((a) => a.code));
	if (allowed.size === 0) throw new Error(`no other active ${statementAccount.currency} accounts to categorise against`);
	const out = new Map();
	const pending = [];
	for (const t of transactions) {
		const rule = rules.get(payeeKey(t.description));
		if (rule && allowed.has(rule.account_code)) {
			out.set(t.id, { code: rule.account_code, confidence: Math.min(0.99, 0.9 + 0.02 * rule.hits), reason: `learned rule (${rule.hits}× before)`, source: "rule" });
		} else pending.push(t);
	}

	const codes = [...allowed];
	const schema = responseSchema(codes);
	const size = Math.max(1, Math.min(batchSize, 200));
	for (let start = 0; start < pending.length; start += size) {
		const slice = pending.slice(start, start + size);
		const batch = slice.map((t, i) => ({ ...t, i: i + 1 }));
		try {
			const { data } = await llm({ system: SYSTEM, prompt: buildPrompt({ statementAccount, candidates, examples, batch }), schema, maxTokens: 16000 });
			const byI = new Map((Array.isArray(data?.results) ? data.results : []).map((r) => [Number(r.i), r]));
			for (const t of batch) {
				const r = byI.get(t.i);
				const proposed = r?.account_code === NEW ? String(r.new_account?.name ?? "").trim().slice(0, 100) : "";
				if (proposed && ACCOUNT_TYPES.includes(r.new_account?.type)) {
					const c = Number(r.confidence);
					out.set(t.id, {
						code: null,
						confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5,
						reason: String(r.reason ?? "").slice(0, 200),
						source: "llm",
						newAccount: { name: proposed, type: r.new_account.type },
					});
				} else if (r && allowed.has(r.account_code)) {
					const c = Number(r.confidence);
					out.set(t.id, {
						code: r.account_code,
						confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5,
						reason: String(r.reason ?? "").slice(0, 200),
						source: "llm",
					});
				} else out.set(t.id, { code: null, confidence: 0, reason: "the model gave no valid answer for this row", source: "error" });
			}
		} catch (err) {
			const reason = String(err.message || err).slice(0, 300);
			// "Not set up" (409) and "not allowed" (403) fail every batch the same way: stop early.
			const fatal = isSetupError(err);
			for (const t of fatal ? pending.slice(start) : batch) out.set(t.id, { code: null, confidence: 0, reason, source: "error" });
			if (fatal) break;
		}
		onProgress?.(Math.min(start + size, pending.length), pending.length);
	}
	return out;
}

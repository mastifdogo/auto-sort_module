// Accounts payable and receivable, and customers' and vendors' own accounts (Ledger 0.31.0).
//
// Since Ledger 0.31.0 every vendor has an account of their own under accounts payable (and every
// customer one under accounts receivable): a line posted to the account tagged "payable" with a
// vendor sits in that vendor's account, and Ledger moves existing lines there. So the account a
// payable line is in is read from the entry, never taken from a setting or a saved code. These
// are the pure helpers for that; they work the same on an older Ledger (no account has `entity`).

/** A payable account: the one tagged "Accounts payable" in Ledger, or a vendor's own account. */
export const isPayable = (a) => !!a && (a.kind === "payable" || a.entity?.role === "vendor");
/** A receivable account: the one tagged "Accounts receivable", or a customer's own account. */
export const isReceivable = (a) => !!a && (a.kind === "receivable" || a.entity?.role === "customer");
/** A customer's or vendor's own account. */
export const isOwn = (a) => !!a?.entity;

const cents = (v) => BigInt(String(v ?? 0));

/**
 * The accounts an entry's payable lines sit in, for a bill posted through `apCode` (the account
 * chosen under Settings or tagged in Ledger when it was approved): that account, the vendors' own
 * accounts and the tagged payable accounts. accounts: Map code -> account.
 */
export function payableCodes(entry, accounts, apCode) {
	const out = new Set();
	for (const l of entry?.lines ?? []) if (l.account_code === apCode || isPayable(accounts.get(l.account_code))) out.add(l.account_code);
	return out;
}

/**
 * Where a bill's payable line sits now: the account its entry credits among payableCodes(). A
 * vendor's own account comes first (Ledger put or moved the line there), then `apCode`, then
 * another tagged payable account. null when the entry credits none of them (the line was moved
 * somewhere else by hand).
 */
export function payableLineAccount(entry, accounts, apCode) {
	const codes = [...payableCodes(entry, accounts, apCode)].filter((c) => (entry.lines ?? []).some((l) => l.account_code === c && cents(l.credit_cents) > 0n));
	return codes.find((c) => isOwn(accounts.get(c))) ?? codes.find((c) => c === apCode) ?? codes[0] ?? null;
}

/**
 * Whether two codes are the same payables (or receivables) for booking a payment: the same account,
 * or one is a customer's or vendor's own account and the other the account it sits under or another
 * account of the same kind (a row offered accounts payable before Ledger moved the line into the
 * vendor's account still pays it).
 */
export function sameControl(code, lineCode, accounts) {
	if (code === lineCode) return true;
	const a = accounts.get(code);
	const l = accounts.get(lineCode);
	if (!a || !l) return false;
	if (isOwn(l) && l.parent_code === code) return true;
	if (isOwn(a) && isOwn(l)) return false; // two different customers or vendors
	return (isPayable(a) && isPayable(l)) || (isReceivable(a) && isReceivable(l));
}

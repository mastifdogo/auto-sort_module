// Bills and receipts: uploaded (PDF, photo or saved email) or sent by another
// module, Ledger's LLM API (ctx.llm) reads them, you approve them, and statement
// transactions that pay them are matched automatically.
//
// Approving a bill or a receipt posts it to accounts payable (the account
// chosen under Settings, else the one Ledger tagged "Accounts payable"):
// Dr <bill account> / Cr <payable>; the matched bank payment then books
// Dr <payable> / Cr <bank>. Since Ledger 0.31.0 the payable side sits in
// the vendor's own account under accounts payable (Ledger routes a line
// posted to the tagged account with the vendor there, and moved the lines
// already posted): bills.ap_account stays the account the bill went
// through, and where its line is now is read from its entry
// (payableOfBill, paymentAccount). Without a payable account, bills are only
// tracked and the payment books straight to the bill's account.
//
// A bill made with Create bill on a card or loan statement (what the statement
// says is owed) isn't a cost: since 0.29.0 it is posted Dr accounts payable
// (a stand-in) / Cr the vendor's own account ("the stand-in" below). Its entry
// stays as posted (0.30.0, Ledger 0.33.0): the payment on that account's own
// statement, linked to the bill, is posted as an entry of its own, Dr the card
// or loan account / Cr accounts payable, which clears the stand-in, and the two
// entries are linked in Ledger. On Ledger 0.32.x the stand-in line is moved to
// the card or loan account instead (ctx.ledger.moveLine), as 0.29.0 did.
// Without either, and for the bills made before, the debit is the module's
// clearing account "Statement bills to clear".
//
// Payments (0.30.0, Ledger 0.33.0): the entry that pays a bill with an entry of
// its own is linked to it in Ledger (ctx.ledger.linkPayment, with the share
// that pays this bill), which shows the payments on the entry and keeps its
// tag unpaid, partially_paid or paid. The bill's status here follows that tag
// (lib/tags.mjs); what is paid and left is read from Ledger (paymentState).

import { bankFirst, formatCents, pickable } from "./categorize.mjs";
import { dashboard } from "./dashboard.mjs";
import { assignMatches, billInfoOf, draftFromBillInfo, extractBill, findDuplicate, findSimilarBills, imageType, normalizeItem, readItems, readStatementBill, suggestSplit } from "./bills.mjs";
import { accountHint, extractPdfStatement, shouldFlip, sourceKey } from "./email-statements.mjs";
import { MODULE_KEY, billData, billFromData, billInfoData, billInfoFromData, statementData } from "./extraction.mjs";
import { parseEmail } from "./mime.mjs";
import { parseAmount, parseDate } from "./parse.mjs";
import { markAmended } from "./ledger-sync.mjs";
import { payableCodes, payableLineAccount } from "./payables.mjs";
import { includedTaxCents, taxCents, taxLabel } from "./taxes.mjs";

const MAX_DOCUMENT_BYTES = 5 << 20;

/**
 * How a bill is booked when it or its line items have accounts or taxes of their own: one line per
 * categorized item, one per tax on the items (worked out on the items' amounts together, as a
 * receipt does), and one for the rest (items left to the bill, a tip) on the bill's own account.
 * A tax with an account is booked there; one without goes with the item's category (it stays in
 * the rest for items left to the bill).
 * The bill's own tax (bill.tax, for the whole bill) is every item's tax unless the item has one of
 * its own or none (no_tax); what the items and their taxes don't cover is taken as including it.
 * → { lines: [{description, amount, account_code}] } ([] when there is nothing to book apart), or
 * { error } when it can't be done. Pure: bill = { amount_cents, account_code, kind, tax },
 * tax = { id, name, rate, account_code } or null; item = { ..., account_code, tax, no_tax }.
 */
export function linesFromItems(bill, items) {
	const own = items.filter((it) => it.account_code);
	const whole = bill.tax ?? null;
	const what = bill.kind === "receipt" ? "receipt" : "bill";
	// Taxes by tax, and for one without an account by the item's category. Booked apart when they
	// have somewhere to go (to); the others stay in the rest but still count as covered.
	const groups = new Map();
	let covered = 0n;
	for (const it of items) {
		const amount = it.amount_cents == null ? 0n : BigInt(it.amount_cents);
		if (it.tax && amount <= 0n) return { error: `"${it.description}" needs an amount above zero to have a tax` };
		if (amount <= 0n) continue;
		covered += amount;
		const tax = it.tax ?? (it.no_tax ? null : whole);
		if (!tax) continue;
		const to = tax.account_code || it.account_code || null;
		const key = `${tax.id}|${tax.account_code ? "" : to ?? "-"}`;
		const g = groups.get(key) ?? { tax, to, base: 0n, n: 0 };
		g.base += amount;
		g.n += 1;
		groups.set(key, g);
	}
	const booked = [...groups.values()].filter((g) => g.to);
	if (own.length === 0 && booked.length === 0 && !whole?.account_code) return { lines: [] };
	if (bill.amount_cents == null) return { error: `enter the ${what}'s amount before giving ${whole ? "it a tax" : "items their own category or tax"}` };
	const total = BigInt(bill.amount_cents);
	const lines = [];
	let sum = 0n;
	for (const it of own) {
		if (it.amount_cents == null || BigInt(it.amount_cents) <= 0n) return { error: `"${it.description}" needs an amount above zero to have its own category` };
		sum += BigInt(it.amount_cents);
		lines.push({ description: String(it.description).slice(0, 200), amount: BigInt(it.amount_cents), account_code: it.account_code });
	}
	let taxed = false;
	for (const g of groups.values()) {
		const amount = taxCents(g.base, g.tax.rate);
		covered += amount;
		if (!g.to || amount <= 0n) continue;
		taxed = true;
		sum += amount;
		lines.push({ description: `${taxLabel(g.tax)} on ${formatCents(g.base)} (${g.n} item${g.n === 1 ? "" : "s"})`.slice(0, 200), amount, account_code: g.to });
	}
	// What no item covers (all of it, without items) includes the whole bill's tax.
	const open = total - covered;
	if (whole?.account_code && open > 0n) {
		const amount = includedTaxCents(open, whole.rate);
		if (amount > 0n) {
			taxed = true;
			sum += amount;
			lines.push({ description: `${taxLabel(whole)} included in ${formatCents(open)}`.slice(0, 200), amount, account_code: whole.account_code });
		}
	}
	if (lines.length === 0) return { lines: [] };
	const rest = total - sum;
	if (rest < 0n) return { error: `the categorized items${taxed ? " and their tax" : ""} add up to ${formatCents(sum)}, more than the ${what}'s ${formatCents(total)}` };
	if (rest > 0n) {
		if (!bill.account_code) return { error: `choose the ${what}'s own category too: ${formatCents(rest)} isn't covered by the categorized items${taxed ? " and their tax" : ""}` };
		const others = taxed ? "other charges" : "tax and other charges";
		const description = items.length === 0 ? `The ${what} without tax` : own.length === items.length ? `Rest (${others})` : `Other items${taxed ? " and" : ","} ${others}`;
		lines.push({ description, amount: rest, account_code: bill.account_code });
	}
	return { lines };
}
const billColumns = (SCHEMA) => `b.id, b.kind, b.status, b.vendor, b.invoice_number, b.bill_date::text AS bill_date, b.due_date::text AS due_date, b.amount_cents,
	b.currency, b.account_code, b.confidence, b.summary, b.error, b.source, b.mail_from, b.mail_subject, b.mail_date,
	d.document_id, d.file_name AS document_name, (d.bill_id IS NOT NULL) AS has_document, d.content_type AS document_type, b.journal_entry_id, b.ap_account, b.paid_entry_id, b.paid_at, b.updated_by, b.created_at, b.updated_at,
	b.billable, b.customer_name, b.customer_ref, b.statement_id, b.vendor_entity_id, b.customer_entity_id, b.paid_by_tag, b.paid_tag_by, b.tags_synced_at, b.lines_from_items, b.tax_id,
	b.standin_account_code, b.standin_line, b.standin_tx_id, b.payments_linked_at,
	(SELECT count(*)::int FROM ${SCHEMA}.bill_lines l WHERE l.bill_id = b.id) AS line_count`;

/**
 * h: { q, T, bad, ai(), requeue(statementIds), stageStatement(parsed, opts), readStatement(file), files, settleFile, tags, dtags }
 * where ai() gives { llm, readsPdf, readsImages }, tags are Ledger's tags on journal entries (lib/tags.mjs) and dtags
 * its tags on files (lib/doc-tags.mjs). Returns what the statement side and the other route files use (see the end).
 */
export function registerBills(ctx, h) {
	const { q, T, bad, tags } = h;
	const BILL_COLUMNS = billColumns(ctx.schema);

	// -----------------------------------------------------------------------
	// Customers and vendors: Ledger's one shared list (ctx.entities, Ledger 0.16.0)
	// -----------------------------------------------------------------------

	/**
	 * Links a bill to its vendor and customer in Ledger's list. create: true (a person saved,
	 * approved or imported it) adds a missing entity or role; false (the AI read the name) only links
	 * one that already exists. Never fails the request: a name Ledger refuses stays unlinked.
	 */
	async function linkEntities(billId, { create }) {
		if (!ctx.entities) return;
		const { rows } = await q(`SELECT vendor, customer_name FROM ${T("bills")} WHERE id = $1`, [String(billId)]);
		if (!rows[0]) return;
		const pick = async (name, role) => {
			const n = String(name ?? "").trim();
			if (!n) return null;
			try {
				if (create) return (await ctx.entities.ensure(n, role)).id;
				const e = await ctx.entities.find(n);
				return e && e.is_active ? e.id : null;
			} catch (err) {
				ctx.log.warn("entity not linked", { bill: String(billId), name: n, role, err: String(err?.message || err) });
				return null;
			}
		};
		await q(`UPDATE ${T("bills")} SET vendor_entity_id = $2, customer_entity_id = $3 WHERE id = $1`, [
			String(billId),
			await pick(rows[0].vendor, "vendor"),
			await pick(rows[0].customer_name, "customer"),
		]);
	}

	/**
	 * The bill's vendor in Ledger's list, for tagging its payment: linked now (and added to the list
	 * when missing) if it isn't yet. Only on a person's action (matching, linking, posting).
	 */
	async function vendorOf(billId) {
		const { rows } = await q(`SELECT vendor, vendor_entity_id FROM ${T("bills")} WHERE id = $1`, [String(billId)]);
		if (!rows[0]) return null;
		if (rows[0].vendor_entity_id === null && String(rows[0].vendor ?? "").trim()) {
			await linkEntities(billId, { create: true });
			return (await q(`SELECT vendor_entity_id FROM ${T("bills")} WHERE id = $1`, [String(billId)])).rows[0]?.vendor_entity_id ?? null;
		}
		return rows[0].vendor_entity_id;
	}
	const dash = dashboard(ctx);

	/** The bill options of this organization's settings. */
	async function billSettings() {
		const v = await ctx.settings.get();
		return { ap_account: String(v.ap_account ?? "").trim() };
	}

	/**
	 * Accounts payable for a bill or receipt in `currency`: the account chosen under Settings, else the
	 * one Ledger has tagged "Accounts payable" in that currency (Ledger 0.30.0 tags it). "" when none.
	 * `accounts`: Ledger's accounts (a Map by code, or a list).
	 */
	function payableOf(mail, accounts, currency) {
		if (mail.ap_account) return mail.ap_account;
		for (const a of accounts.values()) if (a.kind === "payable" && a.is_active !== false && a.currency === currency) return a.code;
		return "";
	}

	/**
	 * Auto sort's own clearing account for bills made from statements (made on first use, one per
	 * currency; Ledger 0.20.0). The bill debits it; what the statement's own lines book clears it.
	 * Since 0.29.0 only where the stand-in can't be used (standinOwnAccount), and for the bills
	 * posted to it before, which stay as they are.
	 */
	const statementBillsAccount = (currency) => ctx.ledger.clearingAccount({ key: "statement_bills", name: "Statement bills to clear", currency, type: "liability" });

	async function accountsByCode() {
		return new Map((await ctx.ledger.listAccounts({ includeInactive: true })).map((a) => [a.code, a]));
	}

	// -----------------------------------------------------------------------
	// The stand-in: a bill from a statement, and the payment on that statement
	// -----------------------------------------------------------------------

	/**
	 * How the payment on the card's or loan's own statement is linked to a bill made from that
	 * account's statement: "entry" (Ledger 0.33.0: the row is posted as an entry of its own, booked to
	 * the stand-in account, and the two entries are linked; no line is moved), "move" (Ledger 0.32.x:
	 * the stand-in line is moved to the row's account, as 0.29.0 did), or null (it can't be linked).
	 */
	const standinMode = tags.paymentsOn && typeof ctx.ledger.relateEntries === "function" ? "entry" : typeof ctx.ledger.moveLine === "function" ? "move" : null;
	/** Whether Create bill on a statement uses the stand-in: its payment can be linked, and Ledger keeps each vendor's own account (0.31.0). */
	const standinOn = standinMode !== null && typeof ctx.entities?.account === "function";

	/**
	 * The vendor's own account a bill from a statement is credited to when accounts payable (`apCode`)
	 * stands in for its debit, or null when the stand-in can't be used: an older Ledger, a bill whose
	 * vendor isn't on Ledger's list, no account tagged "Accounts payable" in its currency to keep the
	 * vendor's account under. Debit and credit would be one account then, so the caller keeps the
	 * clearing account.
	 */
	async function standinOwnAccount(bill, apCode) {
		if (!standinOn || !bill.vendor_entity_id || !apCode) return null;
		try {
			const own = await ctx.entities.account(Number(bill.vendor_entity_id), "vendor", bill.currency);
			return own?.code && own.entity && own.code !== apCode && own.is_active !== false ? own : null;
		} catch (err) {
			ctx.log.warn("no vendor account for a bill from a statement; the clearing account is used", { bill: String(bill.id), err: String(err?.message || err) });
			return null;
		}
	}

	const lineNumber = (l, i) => Number(l.line_number ?? i + 1);
	/** The stand-in line of a bill's entry (by its number), or null. → { line, n } */
	function standinLineOf(bill, entry) {
		if (bill.standin_line == null) return null;
		const i = (entry?.lines ?? []).findIndex((l, k) => lineNumber(l, k) === Number(bill.standin_line));
		return i < 0 ? null : { line: entry.lines[i], n: Number(bill.standin_line) };
	}
	/** Ledger's refusals (a line ticked on a reconciliation, an inactive account) are the person's to read: 409, not 500. */
	async function moveLine(entryId, n, code, reason, user) {
		try {
			return await ctx.ledger.moveLine(entryId, n, code, { reason: reason.slice(0, 500) }, user);
		} catch (err) {
			throw new ctx.HttpError(409, `line ${n} of entry #${entryId} can't be moved to ${code}: ${String(err?.message || err)}`);
		}
	}
	const txLink = (t) => h.txLink?.(t.id, t.statement_id, t.filename, t.description) ?? { ref: `tx:${t.id}`, label: `${t.filename} · ${t.description}`.replace(/\s+/g, " ").trim().slice(0, 200), href: `/apps/${ctx.id}?statement=${t.statement_id}` };

	/** The account of the statement a bill was made from (the card or loan), or null when that statement is gone. */
	async function statementAccountOf(bill) {
		if (bill.statement_id == null) return null;
		return (await q(`SELECT account_code FROM ${T("statements")} WHERE id = $1`, [String(bill.statement_id)])).rows[0]?.account_code || null;
	}

	const STANDIN_ROW = `t.id, t.statement_id, t.account_code, t.tx_date::text AS date, t.description, t.memo, t.fitid, t.amount_cents, t.status, t.journal_entry_id, t.transfer_tx_id, s.filename`;

	/** The rows posted as their own entries that clear a bill's stand-in (0.30.0), oldest first. */
	async function standinRows(billId, txId = null) {
		const { rows } = await q(
			`SELECT ${STANDIN_ROW} FROM ${T("transactions")} t JOIN ${T("statements")} s ON s.id = t.statement_id
			  WHERE t.standin_bill_id = $1 AND t.status = 'posted' AND ($2::bigint IS NULL OR t.id = $2) ORDER BY t.tx_date, t.id`,
			[String(billId), txId === null ? null : String(txId)],
		);
		return rows;
	}
	/** What still stands in accounts payable for a bill: its amount, less the rows that cleared part of it. */
	const standinLeft = (bill, rows) => (bill.amount_cents == null ? 0n : BigInt(bill.amount_cents)) - rows.reduce((s, t) => s + BigInt(t.amount_cents), 0n);

	/**
	 * Links the payment on the card's or loan's own statement to the bill made from that account's
	 * statement. A person's action. The bill's entry stays as posted (Ledger 0.33.0): the row is
	 * posted as an entry of its own, Dr the row's account / Cr accounts payable where the stand-in
	 * is, which clears the stand-in (or the part of it the row is for: several rows can clear one
	 * bill's), and that entry is linked to the bill's entry in Ledger so each shows the other. It is
	 * a plain link, not a payment: the money paid to the vendor is the bank's payment, linked as the
	 * bill's payment when it is posted. On Ledger 0.32.x the stand-in line is moved instead
	 * (linkStandinByMove).
	 */
	async function linkStandin(bill, txId, user) {
		const what = "the payment on the card's or loan's statement";
		if (!bill.standin_account_code) throw new ctx.HttpError(409, `this ${bill.kind} has no stand-in line in accounts payable: only a bill made with Create bill on a statement (since 0.29.0, Ledger 0.32.0) has one`);
		if (!bill.journal_entry_id || bill.standin_line == null) throw new ctx.HttpError(409, "this bill isn't posted; approve it first");
		if (bill.standin_tx_id != null) throw new ctx.HttpError(409, `this bill is already linked to transaction ${bill.standin_tx_id}${standinMode === "entry" ? " the earlier way (its stand-in line was moved to that account)" : ""}; unlink that first`);
		if (standinMode !== "entry") return linkStandinByMove(bill, txId, user);
		const { rows } = await q(`SELECT ${STANDIN_ROW} FROM ${T("transactions")} t JOIN ${T("statements")} s ON s.id = t.statement_id WHERE t.id = $1`, [String(txId)]);
		const t = rows[0];
		if (!t) throw new ctx.HttpError(404, `no transaction ${txId}`);
		if (t.status !== "new") throw new ctx.HttpError(409, `transaction ${t.id} is ${t.status}; only a row waiting to be posted can be linked`);
		const entry = await ctx.ledger.getJournalEntry(Number(bill.journal_entry_id)).catch(() => null);
		if (!entry) throw new ctx.HttpError(409, `the bill's journal entry #${bill.journal_entry_id} is gone`);
		if (entry.reversed_by_id != null || entry.reverses_id != null) throw new ctx.HttpError(409, `the bill's journal entry #${entry.id} was reversed`);
		const accounts = await accountsByCode();
		const account = accounts.get(t.account_code);
		if (!account || !account.is_active || !pickable(account) || !["asset", "liability"].includes(account.type)) throw bad(`transaction ${t.id} isn't on a bank, card or loan account`);
		if (account.currency !== bill.currency) throw bad(`transaction ${t.id} is on ${account.code}, which is in ${account.currency}; the bill is in ${bill.currency}`);
		const standin = accounts.get(bill.standin_account_code);
		if (!standin || standin.is_active === false) throw new ctx.HttpError(409, `accounts payable ${bill.standin_account_code}, where this bill's stand-in is, can't be posted to any more`);
		const home = await statementAccountOf(bill);
		if (home && home !== t.account_code) throw bad(`the bill was made from a statement of ${home}; ${what} is a row on that account, and transaction ${t.id} is on ${t.account_code}`);
		const amount = BigInt(t.amount_cents);
		if (amount <= 0n) throw bad(`${what} is money received on that account; transaction ${t.id} is ${formatCents(amount)}`);
		const left = standinLeft(bill, await standinRows(bill.id));
		if (left <= 0n) throw new ctx.HttpError(409, "the rows linked to this bill already clear its stand-in in accounts payable; unlink one first");
		if (amount > left) throw bad(`transaction ${t.id} is ${formatCents(amount)}, more than the ${formatCents(left)} that still stands in accounts payable for this bill`);
		// Claimed first, so a double click can't post it twice.
		const claim = await q(`UPDATE ${T("transactions")} SET status = 'posting' WHERE id = $1 AND status = 'new'`, [t.id]);
		if (claim.rowCount === 0) throw new ctx.HttpError(409, "this row changed; reload");
		let posted;
		try {
			// Without the vendor: with it Ledger would put the accounts payable line in the vendor's own
			// account, and it is the stand-in, not money paid to the vendor.
			posted = await ctx.ledger.createJournalEntry(
				{
					entry_date: t.date,
					description: String(t.description ?? "").trim().slice(0, 500) || "Card or loan payment",
					reference: (t.fitid || `categorizer ${t.statement_id}/${t.id}`).slice(0, 100),
					lines: [
						{ account_code: t.account_code, debit_cents: amount, credit_cents: 0n, memo: String(t.memo ?? "").slice(0, 500) },
						{ account_code: bill.standin_account_code, debit_cents: 0n, credit_cents: amount, memo: `Clears the stand-in of bill ${bill.id}${bill.vendor ? ` (${bill.vendor})` : ""}, entry #${entry.id}`.slice(0, 500) },
					],
					links: [txLink(t), billLink(bill)],
				},
				user,
			);
		} catch (err) {
			await q(`UPDATE ${T("transactions")} SET status = 'new' WHERE id = $1 AND status = 'posting'`, [t.id]);
			throw err;
		}
		// Its other side of a transfer goes back to being an ordinary row (as when a row is merged).
		let requeue = [];
		if (t.transfer_tx_id) {
			requeue = (await q(`UPDATE ${T("transactions")} SET transfer_tx_id = NULL, suggested_code = NULL, source = '', reason = '' WHERE id = $1 AND status = 'new' RETURNING statement_id`, [t.transfer_tx_id])).rows.map((r) => r.statement_id);
		}
		await q(
			`UPDATE ${T("transactions")} SET status = 'posted', journal_entry_id = $2, posted_by = $3, posted_at = now(), error = NULL, reason = $4, standin_bill_id = $5,
			        suggested_code = NULL, chosen_code = $6, confidence = NULL, source = '', bill_id = NULL, split_cents = NULL, split_account_code = NULL, pays_entry_id = NULL, transfer_tx_id = NULL, transfer_entry_id = NULL
			  WHERE id = $1 AND status = 'posting'`,
			[t.id, posted.id, user.username, `clears the stand-in of bill ${bill.id}${bill.vendor ? ` (${bill.vendor})` : ""}: entry #${posted.id}, linked to the bill's entry #${entry.id}`.slice(0, 200), bill.id, bill.standin_account_code],
		);
		await q(`DELETE FROM ${T("transaction_splits")} WHERE transaction_id = $1`, [t.id]);
		await q(`UPDATE ${T("bills")} SET updated_by = $2, updated_at = now() WHERE id = $1`, [bill.id, user.username]);
		// Each entry shows the other in Ledger. Not a payment link: the vendor is paid once, by the bank's payment.
		await tags.relate(entry.id, posted.id, `the ${account.type === "liability" ? "card's or loan's" : "account's"} side of this bill's payment: clears the stand-in in accounts payable (not counted as money paid to the vendor)`, user);
		ctx.log.info("statement row posted to clear a bill's stand-in", { bill: String(bill.id), tx: String(t.id), entry: String(posted.id), bill_entry: String(entry.id), account: t.account_code, amount: amount.toString(), by: user.username });
		if (requeue.length > 0) await h.requeue(requeue);
		// The payment from the bank, freed from the transfer, can be offered the bill it pays.
		await autoMatch();
		await h.rowsChanged?.([t.statement_id, ...requeue], user);
		return getBill(bill.id);
	}

	/**
	 * Undoes linkStandin for one row (txId) or all of a bill's: the row's own entry is reversed, the
	 * link between the two entries is taken off, and the row waits to be posted again; the bill's
	 * entry isn't touched. An entry already reversed in Ledger (or gone) is left; the row is released
	 * all the same. Returns the statements whose rows changed.
	 */
	async function unlinkStandinRows(bill, user, txId = null, why = "unlinked") {
		const rows = await standinRows(bill.id, txId);
		for (const t of rows) {
			const e = await ctx.ledger.getJournalEntry(Number(t.journal_entry_id)).catch(() => null);
			if (e && e.reversed_by_id == null && e.reverses_id == null) {
				await ctx.ledger.reverseJournalEntry(e.id, { description: `${String(t.description ?? "").trim() || "Card or loan payment"}: ${why} from bill ${bill.id}${bill.vendor ? ` (${bill.vendor})` : ""}`.slice(0, 500) }, user);
			}
			if (e && bill.journal_entry_id && typeof ctx.ledger.unrelateEntries === "function") await ctx.ledger.unrelateEntries(bill.journal_entry_id, e.id).catch(() => false);
			// The reversed entry isn't about this bill any more (it still opens the statement row).
			if (e) await ctx.ledger.unlinkJournalEntry(e.id, `bill:${bill.id}`).catch(() => false);
			await q(
				`UPDATE ${T("transactions")} SET status = 'new', journal_entry_id = NULL, posted_by = NULL, posted_at = NULL, reason = '', standin_bill_id = NULL, chosen_code = NULL WHERE id = $1 AND status = 'posted' AND journal_entry_id = $2`,
				[t.id, String(t.journal_entry_id)],
			);
			ctx.log.info("statement row unlinked from a bill's stand-in; its entry is reversed", { bill: String(bill.id), tx: String(t.id), entry: String(t.journal_entry_id), by: user.username });
		}
		return rows.map((t) => t.statement_id);
	}

	/**
	 * Ledger 0.32.x (no linked payments), as 0.29.0 did: the stand-in line of the bill's entry moves
	 * from accounts payable to the row's account, and the row is settled by that entry (posted in it,
	 * nothing new is posted). Only a row for exactly the line's amount: Ledger moves a whole line.
	 */
	async function linkStandinByMove(bill, txId, user) {
		const what = "the payment on the card's or loan's statement";
		if (typeof ctx.ledger.moveLine !== "function") throw new ctx.HttpError(409, "linking it needs Ledger 0.32.0 or newer");
		const { rows } = await q(`SELECT ${STANDIN_ROW} FROM ${T("transactions")} t JOIN ${T("statements")} s ON s.id = t.statement_id WHERE t.id = $1`, [String(txId)]);
		const t = rows[0];
		if (!t) throw new ctx.HttpError(404, `no transaction ${txId}`);
		if (t.status !== "new") throw new ctx.HttpError(409, `transaction ${t.id} is ${t.status}; only a row waiting to be posted can be linked`);
		const entry = await ctx.ledger.getJournalEntry(Number(bill.journal_entry_id)).catch(() => null);
		if (!entry) throw new ctx.HttpError(409, `the bill's journal entry #${bill.journal_entry_id} is gone`);
		if (entry.reversed_by_id != null || entry.reverses_id != null) throw new ctx.HttpError(409, `the bill's journal entry #${entry.id} was reversed`);
		const at = standinLineOf(bill, entry);
		const debit = at ? BigInt(String(at.line.debit_cents ?? 0)) : 0n;
		if (!at || debit <= 0n) throw new ctx.HttpError(409, `entry #${entry.id} no longer has the bill's stand-in line (line ${bill.standin_line})`);
		const accounts = await accountsByCode();
		const account = accounts.get(t.account_code);
		if (!account || !account.is_active || !pickable(account) || !["asset", "liability"].includes(account.type)) throw bad(`transaction ${t.id} isn't on a bank, card or loan account`);
		if (account.currency !== bill.currency) throw bad(`transaction ${t.id} is on ${account.code}, which is in ${account.currency}; the bill is in ${bill.currency}`);
		const home = await statementAccountOf(bill);
		if (home && home !== t.account_code) throw bad(`the bill was made from a statement of ${home}; ${what} is a row on that account, and transaction ${t.id} is on ${t.account_code}`);
		if (BigInt(t.amount_cents) !== debit) {
			throw bad(`only a payment of exactly ${formatCents(debit)} can be linked (this one is ${formatCents(BigInt(t.amount_cents))}): the whole stand-in line moves to ${t.account_code}. A part payment is booked by hand: choose accounts payable (${bill.standin_account_code}) for that row and post it`);
		}
		// Claimed first, so a double click can't link it twice.
		const claim = await q(`UPDATE ${T("transactions")} SET status = 'posting' WHERE id = $1 AND status = 'new'`, [t.id]);
		if (claim.rowCount === 0) throw new ctx.HttpError(409, "this row changed; reload");
		try {
			// Already there (someone moved it in Ledger): nothing to move.
			if (at.line.account_code !== t.account_code) {
				await moveLine(entry.id, at.n, t.account_code, `Bill ${bill.id} (${bill.vendor || "statement"}): its payment is the transaction of ${t.date} on ${t.filename}; the stand-in line moves from accounts payable to ${t.account_code} (${ctx.name})`, user);
			}
		} catch (err) {
			await q(`UPDATE ${T("transactions")} SET status = 'new' WHERE id = $1 AND status = 'posting'`, [t.id]);
			throw err;
		}
		// Its other side of a transfer goes back to being an ordinary row (as when a row is merged).
		let requeue = [];
		if (t.transfer_tx_id) {
			requeue = (await q(`UPDATE ${T("transactions")} SET transfer_tx_id = NULL, suggested_code = NULL, source = '', reason = '' WHERE id = $1 AND status = 'new' RETURNING statement_id`, [t.transfer_tx_id])).rows.map((r) => r.statement_id);
		}
		await q(
			`UPDATE ${T("transactions")} SET status = 'posted', journal_entry_id = $2, posted_by = $3, posted_at = now(), error = NULL, reason = $4,
			        suggested_code = NULL, chosen_code = NULL, confidence = NULL, source = '', bill_id = NULL, split_cents = NULL, split_account_code = NULL, pays_entry_id = NULL, transfer_tx_id = NULL, transfer_entry_id = NULL
			  WHERE id = $1 AND status = 'posting'`,
			[t.id, entry.id, user.username, `recorded with bill ${bill.id}${bill.vendor ? ` (${bill.vendor})` : ""}: its entry #${entry.id} now debits ${t.account_code}`.slice(0, 200)],
		);
		await q(`DELETE FROM ${T("transaction_splits")} WHERE transaction_id = $1`, [t.id]);
		await q(`UPDATE ${T("bills")} SET standin_tx_id = $2, updated_by = $3, updated_at = now() WHERE id = $1`, [bill.id, t.id, user.username]);
		await ctx.ledger.linkJournalEntry(entry.id, txLink(t), user).catch((err) => ctx.log.warn("journal entry link failed", { entry: String(entry.id), err: String(err?.message || err) }));
		ctx.log.info("statement row linked to a bill's stand-in line", { bill: String(bill.id), tx: String(t.id), entry: String(entry.id), account: t.account_code, by: user.username });
		if (requeue.length > 0) await h.requeue(requeue);
		// The payment from the bank, freed from the transfer, can be offered the bill it pays.
		await autoMatch();
		await h.rowsChanged?.([t.statement_id, ...requeue], user);
		return getBill(bill.id);
	}

	/**
	 * Undoes a link made by moving the line (linkStandinByMove, and every link made by 0.29.0): the
	 * line goes back to accounts payable (where it stood in) and the row is
	 * waiting to be posted again. When the entry is gone or reversed there is nothing to move back;
	 * the row is released all the same. Ledger refusing the move (the line is ticked on a
	 * reconciliation) stops it: 409, nothing changed.
	 */
	async function unlinkStandin(bill, user, why = "unlinked") {
		if (bill.standin_tx_id == null) throw new ctx.HttpError(409, "this bill isn't linked to a payment on its card's or loan's statement");
		if (typeof ctx.ledger.moveLine !== "function") throw new ctx.HttpError(409, "this bill's stand-in line was moved to the card or loan account; moving it back needs Ledger 0.32.0 or newer");
		const { rows } = await q(`SELECT ${STANDIN_ROW} FROM ${T("transactions")} t JOIN ${T("statements")} s ON s.id = t.statement_id WHERE t.id = $1`, [String(bill.standin_tx_id)]);
		const t = rows[0] ?? null;
		const entry = bill.journal_entry_id ? await ctx.ledger.getJournalEntry(Number(bill.journal_entry_id)).catch(() => null) : null;
		const at = entry && entry.reversed_by_id == null && entry.reverses_id == null ? standinLineOf(bill, entry) : null;
		if (at && at.line.account_code !== bill.standin_account_code) {
			await moveLine(entry.id, at.n, bill.standin_account_code, `Bill ${bill.id} (${bill.vendor || "statement"}): ${why}; the line is back in accounts payable, where it stands in (${ctx.name})`, user);
		}
		if (t) {
			await q(
				`UPDATE ${T("transactions")} SET status = 'new', journal_entry_id = NULL, posted_by = NULL, posted_at = NULL, reason = '' WHERE id = $1 AND status = 'posted' AND journal_entry_id = $2`,
				[t.id, String(bill.journal_entry_id)],
			);
			if (entry) await ctx.ledger.unlinkJournalEntry(entry.id, `tx:${t.id}`).catch(() => false);
		}
		await q(`UPDATE ${T("bills")} SET standin_tx_id = NULL, updated_by = $2, updated_at = now() WHERE id = $1`, [bill.id, user.username]);
		ctx.log.info("statement row unlinked from a bill's stand-in line", { bill: String(bill.id), tx: String(bill.standin_tx_id), by: user.username });
		if (t) {
			await autoMatch();
			await h.rowsChanged?.([t.statement_id], user);
		}
		return getBill(bill.id);
	}

	/** Open stand-in bills (posted, no row linked yet) with the account of the statement they were made from. */
	async function openStandins() {
		const { rows } = await q(
			`SELECT b.id, b.vendor, b.invoice_number, b.bill_date::text AS bill_date, b.due_date::text AS due_date, b.amount_cents, b.currency, b.journal_entry_id, s.account_code AS home,
			        (b.amount_cents - COALESCE((SELECT sum(t.amount_cents) FROM ${T("transactions")} t WHERE t.standin_bill_id = b.id AND t.status IN ('posting', 'posted')), 0))::bigint AS left_cents
			   FROM ${T("bills")} b LEFT JOIN ${T("statements")} s ON s.id = b.statement_id
			  WHERE b.standin_account_code IS NOT NULL AND b.standin_line IS NOT NULL AND b.standin_tx_id IS NULL AND b.journal_entry_id IS NOT NULL
			    AND b.status IN ('open', 'paid') AND b.amount_cents IS NOT NULL
			  ORDER BY b.id`,
		);
		// What still stands in (all of it, until a row clears part of it).
		return rows.map((b) => ({ ...b, left_cents: b.left_cents ?? b.amount_cents })).filter((b) => BigInt(b.left_cents) > 0n);
	}
	const day = (d) => Math.round(Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`) / 86_400_000);
	/**
	 * Whether a row can be the payment a stand-in bill waits for: money received on the account the
	 * bill's statement is of, for exactly the bill's amount (what still stands in, after rows that
	 * cleared part of it), dated from the statement's date on (a
	 * few days before, for a date read a little off) until some weeks after it is due.
	 */
	function standinFits(b, t) {
		if (!b.home || b.home !== t.account_code || BigInt(t.amount_cents) !== BigInt(b.left_cents ?? b.amount_cents)) return false;
		const from = b.bill_date ?? b.due_date;
		const to = b.due_date ?? b.bill_date;
		if (!from) return true;
		return day(t.date) >= day(from) - (b.bill_date ? 3 : 45) && day(t.date) <= day(to) + 60;
	}

	/**
	 * Unposted rows of a statement that look like the payment a bill made from that account's statement
	 * waits for (no AI): [{ transaction_id, bill }]. Offered under the row, like a line already in the
	 * journal; a person links it. A pair dismissed there ("Not the same") isn't offered again.
	 */
	async function standinMatches(statementId) {
		const bills = await openStandins();
		if (bills.length === 0) return [];
		const { rows } = await q(
			`SELECT t.id, t.account_code, t.tx_date::text AS date, t.amount_cents FROM ${T("transactions")} t
			  WHERE t.statement_id = $1 AND t.status = 'new' AND t.amount_cents > 0 ORDER BY t.tx_date, t.id`,
			[String(statementId)],
		);
		if (rows.length === 0) return [];
		const { rows: no } = await q(`SELECT tx_id, entry_id FROM ${T("not_duplicates")} WHERE entry_id IS NOT NULL AND tx_id = ANY($1::bigint[])`, [rows.map((t) => String(t.id))]);
		const dismissed = new Set(no.map((d) => `${d.tx_id}-${d.entry_id}`));
		const out = [];
		const taken = new Set();
		for (const t of rows) {
			const b = bills.find((x) => !taken.has(String(x.id)) && standinFits(x, t) && !dismissed.has(`${t.id}-${x.journal_entry_id}`));
			if (!b) continue;
			taken.add(String(b.id));
			out.push({ transaction_id: t.id, bill: { id: b.id, vendor: b.vendor, invoice_number: b.invoice_number, bill_date: b.bill_date, due_date: b.due_date, amount_cents: b.amount_cents, left_cents: b.left_cents, currency: b.currency, entry_id: b.journal_entry_id }, mode: standinMode });
		}
		return out;
	}

	/**
	 * For the bill's page: where its stand-in is, the rows linked to it and the rows that could be.
	 * mode: "entry" (a linked row is posted as its own entry; `rows`, each with its entry, and
	 * left_cents: what still stands in) or "move" (`linked`: the one row the line was moved for; also
	 * what a bill linked by 0.29.0 shows on a newer Ledger).
	 */
	async function standinOf(bill) {
		if (!bill.standin_account_code) return null;
		const home = await statementAccountOf(bill);
		const posted = !!bill.journal_entry_id && bill.standin_line != null;
		const out = { account_code: bill.standin_account_code, statement_account: home, mode: bill.standin_tx_id != null ? "move" : standinMode, can_link: standinMode !== null && posted && bill.standin_tx_id == null, linked: null, rows: [], left_cents: null, candidates: [] };
		const row = (t, extra = {}) => ({ id: t.id, statement_id: t.statement_id, filename: t.filename, account_code: t.account_code, date: t.date, description: t.description, amount_cents: t.amount_cents, ...extra });
		if (bill.standin_tx_id != null) {
			const { rows } = await q(`SELECT ${STANDIN_ROW} FROM ${T("transactions")} t JOIN ${T("statements")} s ON s.id = t.statement_id WHERE t.id = $1`, [String(bill.standin_tx_id)]);
			out.linked = rows[0] ? row(rows[0]) : { id: bill.standin_tx_id, missing: true };
			return out;
		}
		if (standinMode === "entry" && posted) {
			const linked = await standinRows(bill.id);
			out.rows = linked.map((t) => row(t, { journal_entry_id: t.journal_entry_id }));
			out.left_cents = standinLeft(bill, linked);
			out.can_link = out.left_cents > 0n;
			if (out.can_link && home) {
				// Rows for what still stands in first, then smaller ones (each clears a part).
				const { rows } = await q(
					`SELECT ${STANDIN_ROW} FROM ${T("transactions")} t JOIN ${T("statements")} s ON s.id = t.statement_id
					  WHERE t.status = 'new' AND t.account_code = $1 AND t.amount_cents > 0 AND t.amount_cents <= $2 ORDER BY (t.amount_cents = $2) DESC, t.tx_date DESC, t.id DESC LIMIT 20`,
					[home, out.left_cents.toString()],
				);
				out.candidates = rows.map((t) => row(t, { partial: BigInt(t.amount_cents) < out.left_cents }));
			}
		} else if (out.can_link && home && bill.amount_cents != null) {
			const { rows } = await q(
				`SELECT ${STANDIN_ROW} FROM ${T("transactions")} t JOIN ${T("statements")} s ON s.id = t.statement_id
				  WHERE t.status = 'new' AND t.account_code = $1 AND t.amount_cents = $2 ORDER BY t.tx_date DESC, t.id DESC LIMIT 20`,
				[home, String(bill.amount_cents)],
			);
			out.candidates = rows.map((t) => row(t));
		}
		return out;
	}

	/**
	 * A person changed the vendor of a posted stand-in bill: the line in the previous vendor's own
	 * account moves to the new one's. Done here with moveLine, not by taking the vendor tag off and
	 * setting it again (tags.vendorChanged): that would move the line through accounts payable, where
	 * the stand-in line may be, and Ledger would take both for the new vendor's.
	 */
	async function standinVendorChanged(before, after, user) {
		if (!after.vendor_entity_id || typeof ctx.ledger.moveLine !== "function") return;
		const entry = await ctx.ledger.getJournalEntry(Number(after.journal_entry_id)).catch(() => null);
		if (!entry || entry.reversed_by_id != null || entry.reverses_id != null) return;
		const accounts = await accountsByCode();
		const i = entry.lines.findIndex((l) => BigInt(String(l.credit_cents ?? 0)) > 0n && Number(accounts.get(l.account_code)?.entity?.id) === Number(before.vendor_entity_id) && accounts.get(l.account_code).entity.role === "vendor");
		if (i < 0) return;
		const own = await ctx.entities.account(Number(after.vendor_entity_id), "vendor", after.currency);
		if (own.code !== entry.lines[i].account_code) await moveLine(entry.id, lineNumber(entry.lines[i], i), own.code, `Bill ${after.id}: its vendor was changed to ${after.vendor || own.name} (${ctx.name})`, user);
	}

	// -----------------------------------------------------------------------
	// Reading bills and receipts
	// -----------------------------------------------------------------------

	async function pastVendors() {
		const { rows } = await q(
			`SELECT DISTINCT ON (lower(vendor)) vendor, account_code FROM ${T("bills")}
			  WHERE status IN ('open', 'paid') AND account_code IS NOT NULL AND vendor <> '' ORDER BY lower(vendor), updated_at DESC LIMIT 60`,
		);
		return rows;
	}

	async function billAccounts(ap) {
		// Not payables or receivables themselves, nor a customer's or vendor's own account (pickable
		// leaves those out): a bill is booked to what it was for.
		return bankFirst((await ctx.ledger.listAccounts()).filter((a) => a.code !== ap && a.kind !== "payable" && a.kind !== "receivable" && pickable(a)));
	}

	/**
	 * Stages a statement another module sent. The account comes from what was chosen before for this
	 * sender and account number (someone chose it before), else it waits for someone to choose; the
	 * AI's guess (PDFs) is only offered as the suggestion, never used by itself.
	 */
	async function stageEmailStatement(parsed, { filename, email, hint, guess = null, source = "module", uploadedBy = "module", document = null, billInfo = null, aiReading = null, user }) {
		const key = sourceKey(email.from, hint);
		const accounts = await accountsByCode();
		const { rows } = await q(`SELECT account_code, flip_signs FROM ${T("statement_sources")} WHERE source_key = $1`, [key]);
		const known = rows[0] && accounts.get(rows[0].account_code)?.is_active ? accounts.get(rows[0].account_code) : null;
		const guessed = !known && guess && accounts.get(guess)?.is_active ? guess : null;
		const account = known;
		const flip = known ? rows[0].flip_signs : false;
		return h.stageStatement(parsed, {
			filename,
			account,
			flip,
			guess: guessed,
			document,
			uploadedBy,
			user,
			source,
			billInfo,
			aiReading,
			hint,
			mail: { messageId: email.messageId, from: email.from, subject: email.subject, sourceKey: key },
		});
	}

	/**
	 * Stores a bill or receipt from a document (a parsed email, PDF or picture); returns { outcome, bill_id }.
	 * known: what was already read out of the file (lib/extraction.mjs billFromData), so the AI isn't
	 * asked again; else the AI reads it. fileDoc: the file itself when it is a document already
	 * ({ documentId, filename, contentType, size }); else the email's PDF or picture is filed.
	 */
	/**
	 * checkSimilar: when bills or receipts like it are already here, nothing is added; the answer is
	 * { outcome: "similar", reading, similar } for a person to compare (the inbox). allowDuplicate: a
	 * person saw them and wants it added anyway.
	 */
	async function ingest(email, { source, ai, mail, kind = null, known = null, fileDoc = null, user, checkSimilar = false, allowDuplicate = false, readByAi = false }) {
		if (email.messageId) {
			const { rows } = await q(`SELECT id FROM ${T("bills")} WHERE message_id = $1`, [email.messageId]);
			if (rows.length > 0) return { outcome: "duplicate", bill_id: rows[0].id };
		}
		const pdfs = email.attachments.filter((a) => a.contentType === "application/pdf" && a.data.length <= 30 << 20);
		// Photos of a bill or receipt (no PDF): pictures big enough not to be a logo, at most 3.
		const images =
			pdfs.length > 0
				? []
				: email.attachments
						.map((a) => ({ ...a, contentType: imageType(a.data) }))
						.filter((a) => a.contentType && a.data.length <= MAX_DOCUMENT_BYTES)
						.slice(0, 3);
		const accounts = await billAccounts(mail.ap_account);
		let x = known;
		if (!x) x = await extractBill({ llm: ai.llm, readsPdf: ai.readsPdf, readsImages: ai.readsImages, email, pdfs: pdfs.slice(0, 3), images, accounts, examples: await pastVendors(), taxes: await activeTaxes() });
		else if (!x.account_code) {
			// No AI: the account comes from the vendor's past bills, when there are any.
			const past = (await pastVendors()).find((v) => v.vendor.trim().toLowerCase() === x.vendor.trim().toLowerCase());
			if (past && accounts.some((a) => a.code === past.account_code)) x = { ...x, account_code: past.account_code };
		}
		const { rows: recent } = await q(
			`SELECT id, kind, status, vendor, invoice_number, bill_date::text AS bill_date, due_date::text AS due_date, amount_cents, currency, account_code FROM ${T("bills")}
			  WHERE status <> 'ignored' AND created_at > now() - interval '180 days'`,
		);
		if (checkSimilar && !allowDuplicate) {
			const similar = findSimilarBills(x, recent);
			if (similar.length > 0) return { outcome: "similar", reading: x, similar };
		}
		const dup = allowDuplicate ? null : findDuplicate(x, recent);
		if (dup) return { outcome: "duplicate", bill_id: dup.id };
		const doc = pdfs.find((p) => p.data.length <= MAX_DOCUMENT_BYTES) ?? images[0] ?? null;
		const notes = [];
		if (x.kind === "not_bill") notes.push("This doesn't look like a bill; fill in the details or ignore it.");
		if (x.currency === "other") notes.push("The bill is in a currency Ledger doesn't use.");
		if (x.amount_cents === null) {
			notes.push(
				known
					? "No amount was read from this file."
					: pdfs.length > 0 && !ai.readsPdf
						? "No amount found: it's probably in the PDF; Ledger's LLM connection for images and documents can't read PDFs (Settings → LLM API)."
						: images.length > 0 && !ai.readsImages
							? "No amount found: it's probably in the picture; reading pictures needs an LLM connection for images (Settings → LLM API)."
							: "No amount found.",
			);
		}
		const { rows } = await q(
			`INSERT INTO ${T("bills")} (kind, vendor, invoice_number, bill_date, due_date, amount_cents, currency, account_code, confidence, summary, error,
			                            source, message_id, mail_from, mail_subject, mail_date, body_text)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
			[
				kind ?? (x.kind === "receipt" ? "receipt" : "bill"),
				x.vendor,
				x.invoice_number,
				x.bill_date,
				x.due_date,
				x.amount_cents === null ? null : x.amount_cents.toString(),
				x.currency === "USD" ? "USD" : "CAD",
				x.account_code,
				x.confidence,
				known && !readByAi ? x.summary || "Read from the file before; the AI wasn't asked again." : x.summary,
				notes.join(" ") || null,
				source,
				email.messageId,
				email.from.slice(0, 300),
				email.subject.slice(0, 500),
				email.date,
				email.text.slice(0, 50_000),
			],
		);
		// The file is one of Ledger's Documents (the one file store every module shares); bill_documents keeps its id.
		const meta = { kind: kind ?? x.kind, title: `${x.vendor || "Bill"}${x.invoice_number ? ` ${x.invoice_number}` : ""}`.slice(0, 200), doc_date: x.bill_date ?? x.due_date };
		if (fileDoc) await h.files.saveBillFile(rows[0].id, fileDoc, meta, user);
		else if (doc) await h.files.saveBillFile(rows[0].id, { filename: (doc.filename || "document.pdf").slice(0, 200), contentType: doc.contentType, data: doc.data }, meta, user);
		// The individual line items it lists (none marked billable: a person decides that).
		await insertItems(rows[0].id, x.items ?? []);
		await linkEntities(rows[0].id, { create: false });
		return { outcome: (kind ?? x.kind) === "receipt" ? "receipt" : "bill", bill_id: rows[0].id, read: known && !readByAi ? "extracted" : "ai" };
	}

	/**
	 * A person approved (or, once approved, corrected) a bill or receipt: what it says is saved with
	 * its document in Ledger, and with the inbox file it came from, so no module reads the file
	 * again. Before approval what the AI read is only this module's suggestion.
	 */
	async function saveBillExtraction(billId, user) {
		const bill = await getBill(String(billId)).catch(() => null);
		if (!bill || !["open", "paid"].includes(bill.status)) return 0;
		const { rows } = await q(
			`SELECT document_id FROM ${T("bill_documents")} WHERE bill_id = $1 AND document_id IS NOT NULL
			 UNION SELECT document_id FROM ${T("inbox_files")} WHERE bill_id = $1 AND document_id IS NOT NULL`,
			[bill.id],
		);
		if (rows.length === 0) return 0;
		const data = billData(bill, await itemsOf(bill.id));
		let n = 0;
		for (const r of rows) if (await h.files.saveExtracted(r.document_id, { data }, user)) n++;
		return n;
	}

	// -----------------------------------------------------------------------
	// Matching bills to statement transactions
	// -----------------------------------------------------------------------

	/**
	 * The account a payment of this bill is booked to on its statement row: accounts payable as the
	 * bill went through it (or the bill's own account when it didn't). When the row is posted, the
	 * payable side goes to where the bill's line really sits (paymentAccount).
	 */
	const targetOf = (b) => b.ap_account || b.account_code || null;

	/**
	 * Where an approved bill's payable line sits now, read from its entry: its vendor's own account
	 * (Ledger 0.31.0 puts the line there, and moved the ones posted before), else the account it was
	 * posted to. → { code, account, entry } or null (not through payables, or the entry is gone).
	 */
	async function payableOfBill(bill, accounts = null) {
		if (!bill?.journal_entry_id || !bill.ap_account) return null;
		const entry = await ctx.ledger.getJournalEntry(Number(bill.journal_entry_id)).catch(() => null);
		if (!entry) return null;
		const map = accounts ?? (await accountsByCode());
		const code = payableLineAccount(entry, map, bill.ap_account);
		return code === null ? null : { code, account: map.get(code) ?? null, entry };
	}

	/**
	 * At posting: the account the payment of an approved bill debits, when the row books to
	 * payables (`code`: the account the bill went through, or the one its line is in): the account
	 * the bill's payable line sits in now, so that the payment clears what the bill put there (the
	 * vendor's own account since Ledger 0.31.0). null: the row isn't booked as this bill's payment
	 * through payables (the bill isn't approved, or the row was given another account).
	 */
	async function paymentAccount(billId, code) {
		const bill = await getBill(String(billId)).catch(() => null);
		if (!bill || !bill.journal_entry_id || !bill.ap_account || !["new", "open"].includes(bill.status)) return null;
		const at = await payableOfBill(bill);
		if (code !== bill.ap_account && code !== at?.code) return null;
		// An account made inactive since: posted to accounts payable with the vendor, Ledger routes it (and makes the vendor's account active again).
		return at && at.account?.is_active !== false ? at.code : bill.ap_account;
	}

	/** Links unposted outgoing transactions to open bills they pay, and refreshes existing links. */
	async function autoMatch() {
		const n = await matchBills();
		await syncBillTodos();
		return n;
	}

	/** One dashboard to-do per unpaid bill (with its due date); ticked when paid, removed when ignored or deleted. */
	async function syncBillTodos() {
		const { rows } = await q(
			`SELECT b.id, b.kind, b.status, b.vendor, b.invoice_number, b.due_date::text AS due_date, b.amount_cents, b.currency, b.journal_entry_id,
			        b.paid_entry_id, b.vendor_entity_id, b.tags_synced_at, b.ap_account, b.payments_linked_at,
			        (SELECT d.document_id FROM ${T("bill_documents")} d WHERE d.bill_id = b.id) AS document_id,
			        EXISTS (SELECT 1 FROM ${T("transactions")} t WHERE t.bill_id = b.id AND t.status = 'new') AS matched
			   FROM ${T("bills")} b
			  WHERE b.status IN ('new', 'open') OR b.updated_at > now() - interval '3 days'`,
		);
		for (const b of rows) {
			const key = `bill-${b.id}`;
			// The tags on the bill's entry (Ledger 0.23.0) and on its document (0.27.0) follow it: vendor, posted,
			// paid, and overdue as days pass. Its entry or document tagged "paid" by someone else meanwhile: the bill is paid.
			// Where Ledger keeps the entry's unpaid / partially_paid / paid (0.33.0), the bill follows that tag both ways.
			const became = await tags.syncBill(b);
			if (became) b.status = became;
			if (b.kind !== "bill" || b.status === "ignored") await dash.remove(key);
			else if (b.status === "paid") await dash.complete(key);
			else {
				const vendor = b.vendor || "unknown vendor";
				const amount = b.amount_cents === null ? "" : ` ${formatCents(b.amount_cents)} ${b.currency}`;
				const body = [
					b.invoice_number ? `Invoice ${b.invoice_number}.` : "",
					b.status === "new" ? "Check the details on the Bills tab and approve it." : "",
					b.journal_entry_id ? "Posted to accounts payable." : "",
					b.matched ? "Its payment is on a statement: post it on the Statements tab to mark the bill paid." : "",
				].filter(Boolean).join(" ");
				// Past its due date: "Overdue:" and the danger level (Ledger shows the date in red).
				const overdue = b.due_date !== null && b.due_date < today();
				await dash.todo({
					key,
					title: `${overdue ? "Overdue: " : ""}${b.status === "new" ? `Review bill: ${vendor}${amount}` : `Pay ${vendor}${amount}`}`.slice(0, 200),
					body,
					due: b.due_date,
					level: overdue ? "danger" : "info",
					link: `${dash.link}?bill=${b.id}`,
				});
			}
		}
	}

	const today = () => new Date().toISOString().slice(0, 10);

	// Bills go overdue as days pass: refresh the to-dos hourly, in every organization's books.
	const overdueTimer = setInterval(() => {
		ctx.orgs.forEach(() => syncBillTodos()).catch((err) => ctx.log.warn("bill to-do refresh failed", { err: String(err?.message || err) }));
	}, 3_600_000);
	overdueTimer.unref?.();

	async function matchBills() {
		// Keep suggestions of existing links in step with their bill (e.g. after approval moved it to payables).
		await q(
			`UPDATE ${T("transactions")} t SET suggested_code = COALESCE(b.ap_account, b.account_code)
			   FROM ${T("bills")} b
			  WHERE t.bill_id = b.id AND t.status = 'new' AND t.source = 'bill' AND COALESCE(b.ap_account, b.account_code) IS NOT NULL`,
		);
		const { rows: bills } = await q(
			`SELECT b.id, b.kind, b.vendor, b.invoice_number, b.bill_date::text AS bill_date, b.due_date::text AS due_date, b.mail_date::date::text AS mail_date,
			        b.amount_cents, b.currency, b.account_code, b.ap_account
			   FROM ${T("bills")} b
			  WHERE b.status IN ('new', 'open') AND b.amount_cents IS NOT NULL AND COALESCE(b.ap_account, b.account_code) IS NOT NULL
			    AND NOT EXISTS (SELECT 1 FROM ${T("transactions")} t WHERE t.bill_id = b.id AND t.status IN ('new', 'posting', 'posted'))`,
		);
		if (bills.length === 0) return 0;
		const { rows: txs } = await q(
			`SELECT id, statement_id, account_code, tx_date::text AS date, description, amount_cents, rejected_bill_id FROM ${T("transactions")}
			  WHERE status = 'new' AND bill_id IS NULL AND chosen_code IS NULL AND amount_cents < 0
			    AND transfer_tx_id IS NULL AND transfer_entry_id IS NULL`,
		);
		const accounts = await accountsByCode();
		let n = 0;
		for (const currency of ["CAD", "USD"]) {
			const pairs = assignMatches(
				bills.filter((b) => b.currency === currency),
				txs.filter((t) => accounts.get(t.account_code)?.currency === currency),
				(b, t) => t.rejected_bill_id === null || BigInt(t.rejected_bill_id) !== BigInt(b.id),
			);
			for (const { bill, tx, score } of pairs) {
				const reason = `pays ${bill.vendor || "bill"}${bill.invoice_number ? ` #${bill.invoice_number}` : ""}${bill.due_date ? ` due ${bill.due_date}` : ""}`;
				await q(
					`UPDATE ${T("transactions")} SET bill_id = $2, split_cents = NULL, split_account_code = NULL, suggested_code = $3, confidence = $4, reason = $5, source = 'bill', error = NULL
					  WHERE id = $1 AND status = 'new' AND bill_id IS NULL AND chosen_code IS NULL`,
					[tx.id, bill.id, targetOf(bill), score, reason.slice(0, 200)],
				);
				n++;
			}
		}
		if (n > 0) ctx.log.info("bills matched", { matches: n });
		return n;
	}

	/**
	 * What the transactions linked to a bill pay of it (each one's amount, less the part split off to
	 * other accounts): { linked, posted } in cents. except: a transaction left out.
	 */
	async function paidOf(billId, except = null) {
		const { rows } = await q(
			`SELECT COALESCE(sum(-amount_cents - COALESCE(split_cents, 0)), 0)::text AS linked,
			        COALESCE(sum(-amount_cents - COALESCE(split_cents, 0)) FILTER (WHERE status = 'posted'), 0)::text AS posted
			   FROM ${T("transactions")} WHERE bill_id = $1 AND status IN ('new', 'posting', 'posted') AND ($2::bigint IS NULL OR id <> $2)`,
			[String(billId), except === null ? null : String(except)],
		);
		return { linked: BigInt(rows[0]?.linked ?? 0), posted: BigInt(rows[0]?.posted ?? 0) };
	}

	/**
	 * Ledger's linked payments say what is paid of a bill with an entry of its own (0.33.0). One
	 * whose earlier payments aren't linked yet (approved before 0.30.0, or on an older Ledger) gets
	 * them linked first. Returns the bill as it is now.
	 */
	async function ensureLinked(bill, user) {
		if (!tags.paymentsOn || !bill.journal_entry_id || bill.payments_linked_at) return bill;
		await tags.linkBillPayments(bill, user);
		return getBill(bill.id);
	}

	/**
	 * What is paid of a bill and what is left, for the Bills tab and the bill's page:
	 * { payment_status: "unpaid" | "partially_paid" | "paid", paid_cents, left_cents, payments_from }.
	 * From Ledger's linked payments (payments_from "ledger") for a bill whose payments are linked
	 * there, so the page says what the entry's page in Ledger says; else from the module's own
	 * posted payment rows ("module"). A paid bill is "paid" whatever was posted for it (Mark paid).
	 * ledger: Ledger's payments when the caller has read them; posted: the rows' total when it has.
	 */
	async function paymentState(bill, { ledger, posted } = {}) {
		const amount = bill.amount_cents == null ? null : BigInt(bill.amount_cents);
		const byLedger = tags.managed(bill);
		if (byLedger && ledger === undefined) ledger = await tags.payments(bill.journal_entry_id);
		let paid;
		let left;
		if (byLedger && ledger !== false) {
			paid = ledger ? ledger.paid_cents : 0n;
			left = ledger ? ledger.left_cents : amount;
		} else {
			paid = posted === undefined ? (await paidOf(bill.id)).posted : BigInt(posted ?? 0);
			left = amount === null ? null : amount > paid ? amount - paid : 0n;
		}
		const payment_status = bill.status === "paid" ? "paid" : paid > 0n && bill.status !== "ignored" ? "partially_paid" : "unpaid";
		return { payment_status, paid_cents: paid, left_cents: left, payments_from: byLedger && ledger !== false ? "ledger" : "module" };
	}

	/**
	 * What is still to pay on a bill after the transactions linked to it (null: no amount yet):
	 * what Ledger says is left, less the linked rows not posted yet; without Ledger's linked
	 * payments, the amount less every linked row. except: a transaction left out.
	 */
	async function owedOf(bill, except = null) {
		if (bill.amount_cents == null) return null;
		const mine = await paidOf(bill.id, except);
		const ledger = tags.managed(bill) ? await tags.payments(bill.journal_entry_id) : false;
		if (ledger === false) return BigInt(bill.amount_cents) - mine.linked;
		return (ledger ? ledger.left_cents : BigInt(bill.amount_cents)) - (mine.linked - mine.posted);
	}

	/**
	 * After this module linked or unlinked a payment in Ledger itself (Ledger's tag changes made in
	 * its name aren't acted on by the listener): the bill's status follows the tag on its entry, and
	 * its to-do with it.
	 */
	async function settle(billId, user) {
		const became = await tags.syncBill(await getBill(String(billId)), user);
		if (became === "paid") {
			await unlink(billId);
			await dash.complete(`bill-${billId}`);
		}
		if (became === "open") await h.dtags.clearPaid(billId);
		await syncBillTodos();
		return became;
	}

	/**
	 * Called after a statement transaction is posted. Answers whether it was booked as its bill's
	 * payment; the bill is paid once its posted payments add up to its amount (several transactions
	 * can pay one bill, each a part). share: what the row pays of the bill, in cents (its amount,
	 * less what is split off to other accounts). For a bill with an entry of its own the payment's
	 * entry is linked to it in Ledger with that share (0.33.0), and Ledger says whether the bill is
	 * paid, partially paid or unpaid; nothing is worked out here then.
	 */
	async function onPosted(txId, code, entryId, user, { payable = false, share = null } = {}) {
		// payable: the row was booked as the bill's payment through payables (paymentAccount), whichever
		// of the payable accounts its code names.
		if (payable) code = (await q(`SELECT COALESCE(b.ap_account, b.account_code) AS code FROM ${T("bills")} b JOIN ${T("transactions")} t ON t.bill_id = b.id WHERE t.id = $1`, [txId])).rows[0]?.code ?? code;
		const { rows: of } = await q(
			`SELECT b.id, b.amount_cents FROM ${T("bills")} b JOIN ${T("transactions")} t ON t.bill_id = b.id
			  WHERE t.id = $1 AND COALESCE(b.ap_account, b.account_code) = $2 AND b.status IN ('new', 'open')`,
			[txId, code],
		);
		if (of.length === 0) return false;
		let linked = null;
		if (tags.paymentsOn) {
			const bill = await getBill(String(of[0].id)).catch(() => null);
			if (bill?.journal_entry_id) {
				// Payments posted before 0.30.0 are linked first; this one is among them then.
				if (!bill.payments_linked_at) await tags.linkBillPayments(bill, user);
				else await tags.linkPayment(bill.journal_entry_id, entryId, share, `payment of ${bill.kind} ${bill.vendor || `#${bill.id}`}${bill.invoice_number ? ` ${bill.invoice_number}` : ""} (${ctx.name})`, user);
				linked = (await tags.payments(bill.journal_entry_id)) || null;
			}
		}
		if (linked ? linked.status !== "paid" : of[0].amount_cents != null && (await paidOf(of[0].id)).posted < BigInt(of[0].amount_cents)) {
			// Paid in part: it stays open until the rest is posted.
			await syncBillTodos();
			return true;
		}
		const { rows } = await q(
			`UPDATE ${T("bills")} b SET status = 'paid', paid_entry_id = $3, paid_at = now(), paid_by_tag = false, paid_tag_by = NULL, updated_at = now()
			   FROM ${T("transactions")} t
			  WHERE t.id = $1 AND t.bill_id = b.id AND COALESCE(b.ap_account, b.account_code) = $2 AND b.status IN ('new', 'open')
			  RETURNING b.id`,
			[txId, code, entryId],
		);
		for (const r of rows) {
			await dash.complete(`bill-${r.id}`);
			// A person posted its payment: the bill's entry is tagged "paid" (and no longer "overdue").
			await tags.syncBill(await getBill(String(r.id)), user);
		}
		return true;
	}

	/** Unlinks a bill's unposted transactions (all, or the one given) and re-categorises their statements. */
	async function unlink(billId, txId = null) {
		const only = txId === null ? null : String(txId);
		await q(`DELETE FROM ${T("transaction_splits")} WHERE transaction_id IN (SELECT id FROM ${T("transactions")} WHERE bill_id = $1 AND status IN ('new', 'skipped') AND ($2::bigint IS NULL OR id = $2))`, [billId, only]);
		const { rows } = await q(
			`UPDATE ${T("transactions")} SET bill_id = NULL, split_cents = NULL, split_account_code = NULL, split_memo = '',
			        suggested_code = CASE WHEN source = 'bill' THEN NULL ELSE suggested_code END,
			        confidence = CASE WHEN source = 'bill' THEN NULL ELSE confidence END,
			        reason = CASE WHEN source = 'bill' THEN '' ELSE reason END,
			        source = CASE WHEN source = 'bill' THEN '' ELSE source END
			  WHERE bill_id = $1 AND status IN ('new', 'skipped') AND ($2::bigint IS NULL OR id = $2) RETURNING statement_id`,
			[billId, only],
		);
		const ids = [...new Set(rows.map((r) => r.statement_id))];
		if (ids.length > 0) await h.requeue(ids);
	}

	// -----------------------------------------------------------------------
	// Routes: bills
	// -----------------------------------------------------------------------

	async function getBill(id) {
		if (!/^\d+$/.test(String(id))) throw new ctx.HttpError(404, "no such bill");
		const { rows } = await q(`SELECT ${BILL_COLUMNS} FROM ${T("bills")} b LEFT JOIN ${T("bill_documents")} d ON d.bill_id = b.id WHERE b.id = $1`, [id]);
		if (rows.length === 0) throw new ctx.HttpError(404, "no such bill");
		return withTax(rows[0]);
	}
	/** The bill with its own tax (for the whole bill) as linesFromItems needs it. */
	async function withTax(bill) {
		const tax_id = bill.tax_id == null ? null : String(bill.tax_id);
		return { ...bill, tax_id, tax: tax_id === null ? null : taxOf((await h.taxes.taxesById()).get(tax_id)) };
	}
	/**
	 * Works out the lines again after the bill's amount, account or tax changed (not a split made
	 * by hand, which stays as it is).
	 */
	async function rebook(billId) {
		const bill = await getBill(billId);
		if (!bill.lines_from_items && (await linesOf(billId)).length > 0) return;
		const plan = linesFromItems(bill, await itemsOf(billId));
		if (!plan.error) await writeLines(billId, plan.lines, true);
	}

	async function paymentOf(id) {
		const { rows } = await q(
			`SELECT t.id, t.statement_id, t.account_code, t.tx_date::text AS date, t.description, t.amount_cents, t.status, t.journal_entry_id,
			        COALESCE(t.chosen_code, t.suggested_code) AS code, t.confidence, t.split_cents, t.split_account_code, t.split_memo,
			        (SELECT COALESCE(json_agg(json_build_object('amount_cents', s.amount_cents, 'account_code', s.account_code, 'memo', s.memo) ORDER BY s.line_no), '[]'::json)
			           FROM ${T("transaction_splits")} s WHERE s.transaction_id = t.id AND t.split_cents IS NOT NULL) AS split_lines
			   FROM ${T("transactions")} t WHERE t.bill_id = $1 ORDER BY t.id DESC`,
			[id],
		);
		return rows;
	}

	ctx.route("GET", "/bills", async (req) => {
		const status = req.query.get("status") || "";
		if (status && !["new", "open", "paid", "ignored", "unpaid"].includes(status)) throw bad("unknown status");
		const kind = req.query.get("kind") || "";
		if (kind && !["bill", "receipt"].includes(kind)) throw bad('kind must be "bill" or "receipt"');
		const where = `(CASE WHEN $1::text = 'unpaid' THEN b.status IN ('new', 'open') WHEN $1::text = '' THEN TRUE ELSE b.status = $1::text END) AND ($2::text = '' OR b.kind = $2::text)`;
		const { rows } = await q(
			`SELECT ${BILL_COLUMNS},
			        (SELECT t.id FROM ${T("transactions")} t WHERE t.bill_id = b.id ORDER BY t.id DESC LIMIT 1) AS transaction_id,
			        (SELECT t.status FROM ${T("transactions")} t WHERE t.bill_id = b.id ORDER BY t.id DESC LIMIT 1) AS transaction_status,
			        (SELECT COALESCE(sum(-t.amount_cents - COALESCE(t.split_cents, 0)), 0)::bigint FROM ${T("transactions")} t WHERE t.bill_id = b.id AND t.status = 'posted') AS posted_cents
			   FROM ${T("bills")} b LEFT JOIN ${T("bill_documents")} d ON d.bill_id = b.id WHERE ${where}
			  ORDER BY (b.status IN ('new', 'open')) DESC, COALESCE(b.due_date, b.bill_date, b.created_at::date) ASC, b.id DESC LIMIT 500`,
			[status, kind],
		);
		// Unpaid, partially paid (with what is paid and left) or paid: what Ledger's linked payments say
		// for a bill whose payments are linked there, the posted payment rows otherwise.
		for (const b of rows) {
			const posted = b.posted_cents ?? 0;
			delete b.posted_cents;
			Object.assign(b, ["new", "open"].includes(b.status) ? await paymentState(b, { posted }) : { payment_status: b.status === "paid" ? "paid" : "unpaid", paid_cents: null, left_cents: null });
		}
		return { data: rows };
	});

	ctx.route("GET", "/bills/:id", async (req) => {
		const bill = await getBill(req.params.id);
		const { rows } = await q(`SELECT body_text FROM ${T("bills")} WHERE id = $1`, [bill.id]);
		const { rows: doc } = await q(`SELECT storage_path, document_id FROM ${T("bill_documents")} WHERE bill_id = $1`, [bill.id]);
		// The file opens straight from Ledger's Documents (or the module's storage, for older ones).
		// After a restore a row can point at a file that isn't there any more: then there's no document.
		const document_url = await h.files.billFileUrl(bill.id);
		const has_document = doc[0]?.storage_path || doc[0]?.document_id ? !!document_url : bill.has_document;
		const out = { ...bill, has_document, body_text: rows[0].body_text, document_url };
		// Ledger's tags on the file (posted, paid, overdue, extracted), whoever set them.
		out.document_tags = has_document && doc[0]?.document_id != null ? ((await h.dtags.of(doc[0].document_id)) ?? []).map((t) => ({ tag: t.tag, note: t.note, module_id: t.module_id, set_by: t.set_by })) : [];
		// The payable entry may have been changed by a person in Ledger (0.19.5): it credits accounts payable,
		// or the vendor's own account under it (Ledger 0.31.0), which isn't a change of the bill.
		if (out.ap_account) {
			const accounts = await accountsByCode();
			// A stand-in bill: only the account its credit is in (the stand-in debit may be in accounts payable too).
			const credited = (b, e) => (b.standin_account_code ? new Set([payableLineAccount(e, accounts, b.ap_account)]) : payableCodes(e, accounts, b.ap_account));
			await markAmended(ctx, [out], credited, { sign: -1n, dateOf: (b) => b.bill_date ?? b.due_date ?? null });
			// Where its payable line sits now, for the page: the vendor's own account, or accounts payable.
			const at = await payableOfBill(out, accounts);
			out.payable_account = at?.account ? { code: at.code, name: at.account.name, own: !!at.account.entity } : null;
		}
		const payments = await paymentOf(bill.id);
		await markAmended(ctx, payments, (p) => p.account_code);
		// What is paid and left. For a bill whose payments are linked in Ledger (0.33.0) that is what
		// Ledger's entry page shows: each row says what Ledger counts of it (linked_cents; counted:
		// false for a reversed payment or one Ledger has no link for), and other_payments are the
		// payments linked there that aren't rows of this bill (linked by hand, or by someone else).
		const ledger = tags.managed(out) ? await tags.payments(out.journal_entry_id) : false;
		Object.assign(out, await paymentState(out, { ledger }), { remaining_cents: await owedOf(out), due_cents: ledger ? ledger.due_cents : null, other_payments: [] });
		if (ledger !== false) {
			const byEntry = new Map((ledger?.payments ?? []).map((x) => [String(x.entry_id), x]));
			const mine = new Set();
			for (const t of payments) {
				if (t.status !== "posted" || t.journal_entry_id === null) continue;
				const x = byEntry.get(String(t.journal_entry_id));
				mine.add(String(t.journal_entry_id));
				Object.assign(t, { linked_cents: x ? x.amount_cents : null, counted: x ? x.counted : false });
			}
			out.other_payments = (ledger?.payments ?? []).filter((x) => !mine.has(String(x.entry_id)));
		}
		// A bill from a statement: its stand-in and the payment on that statement (linked, or to link).
		out.standin = await standinOf(out);
		return { bill: out, payments, lines: await linesOf(bill.id), items: await itemsOf(bill.id), rate_items: tags.ratesOn };
	});

	ctx.route("GET", "/bills/:id/document", async (req) => {
		if (!/^\d+$/.test(req.params.id)) throw new ctx.HttpError(404, "no such bill");
		const f = await h.files.readBillFile(req.params.id);
		if (!f) throw new ctx.HttpError(404, "this bill has no document");
		return { name: f.name, type: f.type, url: f.url, data: f.data.toString("base64") };
	});

	/** Validated field changes from a request body. */
	async function billFields(b, current = null) {
		const f = {};
		if (b.kind !== undefined) {
			if (!["bill", "receipt"].includes(b.kind)) throw bad('kind must be "bill" or "receipt"');
			f.kind = b.kind;
		}
		for (const [k, max] of [["vendor", 200], ["invoice_number", 100]]) {
			if (b[k] === undefined) continue;
			if (typeof b[k] !== "string" || b[k].length > max) throw bad(`${k} must be a string of at most ${max} characters`);
			f[k] = b[k].trim();
		}
		for (const k of ["bill_date", "due_date"]) {
			if (b[k] === undefined) continue;
			if (b[k] === null || b[k] === "") f[k] = null;
			else if (!(f[k] = parseDate(b[k]))) throw bad(`${k} must be a date (YYYY-MM-DD)`);
		}
		if (b.amount !== undefined) {
			if (b.amount === null || b.amount === "") f.amount_cents = null;
			else {
				const a = parseAmount(typeof b.amount === "number" ? b.amount.toFixed(2) : b.amount);
				if (a === null || a <= 0n) throw bad("amount must be a positive amount");
				f.amount_cents = a.toString();
			}
		}
		if (b.currency !== undefined) {
			if (!["CAD", "USD"].includes(b.currency)) throw bad("currency must be CAD or USD");
			f.currency = b.currency;
		}
		if (b.account_code !== undefined) {
			if (b.account_code === null || b.account_code === "") f.account_code = null;
			else {
				const a = (await accountsByCode()).get(b.account_code);
				if (!a || !a.is_active || !pickable(a)) throw bad(`no active account with code ${JSON.stringify(b.account_code)} to choose`);
				f.account_code = a.code;
			}
		}
		if (b.billable !== undefined) {
			if (typeof b.billable !== "boolean") throw bad("billable must be true or false");
			f.billable = b.billable;
		}
		if (b.customer_name !== undefined) {
			if (typeof b.customer_name !== "string" || b.customer_name.length > 200) throw bad("customer_name must be a string of at most 200 characters");
			f.customer_name = b.customer_name.trim();
		}
		if (b.customer_ref !== undefined) {
			if (typeof b.customer_ref !== "string" || !/^([a-z][a-z0-9-]{1,31}:[A-Za-z0-9_-]{1,64})?$/.test(b.customer_ref)) throw bad('customer_ref must be "<module>:<id>" or empty');
			f.customer_ref = b.customer_ref;
		}
		// No customer, no customer reference.
		if (f.customer_name === "" || (f.customer_ref && (f.customer_name ?? current?.customer_name ?? "") === "")) f.customer_ref = "";
		if (current && !current.lines_from_items && (await linesOf(current.id)).length > 0 && "amount_cents" in f && String(f.amount_cents) !== String(current.amount_cents)) {
			throw new ctx.HttpError(409, "this is split into lines; change or remove the split first");
		}
		// A tax for the whole bill or receipt (null: none). Its lines are worked out below.
		if (b.tax_id !== undefined && String(b.tax_id ?? "") !== String(current?.tax_id ?? "")) {
			if (b.tax_id === null || b.tax_id === "") f.tax_id = null;
			else {
				const t = /^\d{1,18}$/.test(String(b.tax_id)) ? (await h.taxes.taxesById()).get(String(b.tax_id)) : null;
				if (!t || !t.active) throw bad("tax_id must be one of the taxes in use, or empty for none");
				const currency = f.currency ?? current?.currency;
				const a = t.account_code ? (await accountsByCode()).get(t.account_code) : null;
				if (t.account_code && (!a || !a.is_active || !pickable(a))) throw bad(`${t.name}'s account ${t.account_code} can't be used any more; add the tax again with another account`);
				if (a && currency && a.currency !== currency) throw bad(`${t.name} is booked to ${a.code}, which is in ${a.currency}, not ${currency}`);
				f.tax_id = t.id;
			}
			if (current) {
				if ((await linesOf(current.id)).length > 0 && !current.lines_from_items) throw new ctx.HttpError(409, "this is split into lines by hand; remove the split before choosing a tax");
				await assertSplittable(current);
			}
		}
		// Lines made from the items' categories and taxes follow the bill: checked here that they still can.
		if ((current?.lines_from_items && ("amount_cents" in f || "account_code" in f)) || "tax_id" in f) {
			const next = await withTax({ kind: "bill", ...current, ...f });
			const plan = linesFromItems(next, current ? await itemsOf(current.id) : []);
			if (plan.error) throw new ctx.HttpError(409, current?.lines_from_items ? `${plan.error}; change the items' categories first` : plan.error);
		}
		if (current && ["amount_cents", "account_code", "currency"].some((k) => k in f && String(f[k]) !== String(current[k])) && (await paymentOf(current.id)).some((t) => t.status === "posted")) {
			throw new ctx.HttpError(409, `a payment of this ${current.kind} is posted; its amount, account and currency can't change now`);
		}
		if (current?.journal_entry_id && ["amount_cents", "account_code", "currency", "bill_date", "kind"].some((k) => k in f && String(f[k]) !== String(current[k]))) {
			throw new ctx.HttpError(409, "this bill is posted to payables; undo the approval before changing its amount, account, currency or date");
		}
		return f;
	}

	async function applyFields(id, f, username) {
		const keys = Object.keys(f);
		if (keys.length === 0) return;
		await q(
			`UPDATE ${T("bills")} SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_by = $${keys.length + 2}, updated_at = now() WHERE id = $1`,
			[id, ...keys.map((k) => f[k]), username],
		);
	}

	ctx.route("POST", "/bills", async (req) => {
		const b = req.body ?? {};
		const f = await billFields(b);
		if (!f.vendor) throw bad("vendor is required");
		let statementId = null;
		if (b.statement_id !== undefined && b.statement_id !== null) {
			// A bill for what a statement says is owed (Statements tab → Create bill).
			if (!/^\d+$/.test(String(b.statement_id))) throw bad("statement_id must be a statement id");
			const { rows: st } = await q(`SELECT id FROM ${T("statements")} WHERE id = $1`, [String(b.statement_id)]);
			if (st.length === 0) throw new ctx.HttpError(404, "no such statement");
			statementId = st[0].id;
			const { rows: dup } = await q(`SELECT id FROM ${T("bills")} WHERE statement_id = $1 AND status <> 'ignored'`, [statementId]);
			if (dup.length > 0) throw new ctx.HttpError(409, `this statement already has bill #${dup[0].id}`);
		}
		// What a statement says is owed isn't a cost of its own (its lines are): the bill is an unpaid
		// bill straight away. Accounts payable stands in for its debit and its vendor's own account is
		// credited; the payment on that account's statement, linked to the bill (linkStandin), is posted
		// against the stand-in and the bill's entry stays as it is. Where that can't be (standinOwnAccount), the
		// debit is Auto sort's clearing account, as before 0.29.0.
		let apCode = "";
		if (statementId) {
			if (f.amount_cents == null) throw bad("enter the amount owed");
			const currency = f.currency ?? "CAD";
			apCode = payableOf(await billSettings(), await accountsByCode(), currency);
			if (!apCode) {
				throw new ctx.HttpError(409, `a bill from a statement is posted to accounts payable, and there is no ${currency} one: tag an account "Accounts payable" on Ledger's Accounts page, or choose one under Settings → ${ctx.name} → Bills`);
			}
		}
		const { rows } = await q(`INSERT INTO ${T("bills")} (source, vendor, updated_by, statement_id) VALUES ($1, $2, $3, $4) RETURNING id`, [
			statementId ? "statement" : "upload",
			f.vendor,
			req.user.username,
			statementId,
		]);
		await applyFields(rows[0].id, f, req.user.username);
		if (f.tax_id) await rebook(rows[0].id);
		await linkEntities(rows[0].id, { create: true });
		// A person said what the statement says is owed: that is kept with the statement's document.
		if (statementId) {
			// Posted at once: it is on the Bills tab as an unpaid bill.
			try {
				const made = await getBill(rows[0].id);
				const own = await standinOwnAccount(made, apCode);
				await applyFields(made.id, own ? { account_code: apCode, standin_account_code: apCode } : { account_code: (await statementBillsAccount(made.currency)).code }, req.user.username);
				await saveStatementOwed(statementId, made, req.user);
				return ctx.response(201, await approveBill(rows[0].id, req.user));
			} catch (e) {
				// Not posted (the date is in a closed period, say): no half-made bill is left behind.
				await q(`DELETE FROM ${T("bills")} WHERE id = $1 AND journal_entry_id IS NULL`, [rows[0].id]);
				throw e;
			}
		}
		await autoMatch();
		return ctx.response(201, await getBill(rows[0].id));
	});

	/** What a statement says is owed, as a person entered or confirmed it, saved with the statement's document. */
	async function saveStatementOwed(statementId, bill, user) {
		const docId = await h.files.statementDocumentId(statementId);
		if (docId === null) return;
		const owed = billInfoData({ vendor: bill.vendor, statement_date: bill.bill_date, due_date: bill.due_date, amount_cents: bill.amount_cents, reference: bill.invoice_number, currency: bill.currency, from: "person" });
		if (!owed) return;
		const have = (await h.files.extractedOf(docId))?.data?.[MODULE_KEY];
		await h.files.saveExtracted(docId, { data: { ...owed.data, [MODULE_KEY]: { ...(have && typeof have === "object" ? have : {}), ...owed.mine } } }, user);
	}

	// POST /bills/upload {"filename": "invoice.pdf", "content_base64": "..."}: a PDF or a saved .eml file.
	ctx.route("POST", "/bills/upload", async (req) => {
		const b = req.body ?? {};
		const filename = typeof b.filename === "string" ? b.filename.trim().slice(0, 200) : "";
		if (typeof b.content_base64 !== "string" || b.content_base64 === "") throw bad("content_base64 is required");
		// White space out first: a pattern that allows it anywhere backtracks for minutes on a long run of spaces.
		const b64 = b.content_base64.replace(/\s+/g, "");
		if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw bad("content_base64 must be base64");
		const data = Buffer.from(b64, "base64");
		if (data.length === 0) throw bad("the file is empty");
		const r = await ingestDocument({ filename, data, source: "upload", user: req.user });
		if (r.outcome === "duplicate") throw new ctx.HttpError(409, `this looks like bill #${r.bill_id}, which is already here`);
		await autoMatch();
		return ctx.response(201, await getBill(r.bill_id));
	});

	/**
	 * A bill or receipt as a file (a PDF, a picture or a saved email): from an upload, the inbox, or
	 * another module (kind given). The file is filed in Ledger's Documents first (documentId: it is one
	 * already). What was read out of it before (by this module once a person approved it, or by another
	 * module) is used as it is; only a file nobody has read goes to the AI.
	 */
	async function ingestDocument({ filename, data, source, kind = null, from = "", note = "", documentId = null, user, mail: fromMail = null, checkSimilar = false, allowDuplicate = false, reading = null }) {
		const mail = await billSettings();
		const isPdf = /\.pdf$/i.test(filename) || data.subarray(0, 5).toString("latin1") === "%PDF-";
		const picture = isPdf ? null : imageType(data);
		let email = null;
		if (!isPdf && !picture) {
			email = parseEmail(data);
			if (!email.subject && !email.text && email.attachments.length === 0) throw bad("this isn't a PDF, a picture or a saved email (.eml)");
		}
		if (picture && data.length > MAX_DOCUMENT_BYTES) throw bad(`the picture is larger than ${MAX_DOCUMENT_BYTES >> 20} MB; send a smaller one`);
		// The file itself, in Ledger's Documents (a saved email that came by upload is read and not kept; its PDF or picture is).
		let docId = documentId;
		let added = false;
		if (docId === null && (isPdf || picture)) {
			({ id: docId, added } = await h.files.fileDocument({ kind: kind === "receipt" ? "receipt" : "invoice", filename: (filename || (isPdf ? "bill.pdf" : "receipt.jpg")).slice(0, 200), data, content_type: isPdf ? "application/pdf" : picture, note: note.slice(0, 2000) }, user));
		}
		const undo = async () => {
			if (added) await h.files.removeDocumentIfUnused(docId);
		};
		const fileDoc = docId !== null && (isPdf || picture) ? { documentId: docId, filename: (filename || "document").slice(0, 200), contentType: isPdf ? "application/pdf" : picture, size: data.length } : null;
		try {
			// Read before? Then the AI isn't asked again.
			// What was read a moment ago (the inbox kept it while a person compared it with similar ones), or before.
			const known = reading ?? (docId === null ? null : billFromData((await h.files.extractedOf(docId))?.data));
			const subject = fromMail?.subject || note || filename;
			const opts = { source, mail, kind, fileDoc, user, checkSimilar, allowDuplicate };
			if (known) {
				email ??= { subject, from: fromMail?.from ?? from, date: null, messageId: null, text: note, attachments: [] };
				const r = await ingest(email, { ...opts, ai: null, known, readByAi: reading !== null });
				if (r.outcome === "duplicate" || r.outcome === "similar") await undo();
				return r;
			}
			const ai = await h.ai();
			if (isPdf) {
				if (!ai.readsPdf) throw bad("Ledger's LLM connection for images and documents can't read PDFs (an admin can choose one that does under Settings → LLM API); upload the bill's email (.eml) or a photo, or enter it by hand");
				email = { subject, from: fromMail?.from ?? from, date: null, messageId: null, text: note, attachments: [{ filename: filename || "bill.pdf", contentType: "application/pdf", data }] };
			} else if (picture) {
				// A photo or scan of the bill or receipt.
				if (!ai.readsImages) throw bad("reading pictures needs an LLM connection for images (an admin can add one under Settings → LLM API); enter it by hand instead");
				email = { subject, from: fromMail?.from ?? from, date: null, messageId: null, text: note, attachments: [{ filename: filename || "receipt.jpg", contentType: picture, data }] };
			}
			const r = await ingest(email, { ...opts, ai });
			if (r.outcome === "duplicate" || r.outcome === "similar") await undo();
			return r;
		} catch (err) {
			await undo();
			throw err;
		}
	}

	/**
	 * A statement or transaction list from another module: CSV/OFX/QFX/QBO, or a PDF read by the AI.
	 * documentId: the document the file is (Ledger 0.27.0 hands files over as documents); what was
	 * read out of it already is used instead of parsing it or asking the AI again.
	 * The account comes from meta.account_code, or what was chosen before for this module and account
	 * number, or waits to be chosen on the Statements tab. Returns stageStatement's result.
	 */
	async function ingestStatementFile({ filename, data, contentType, sender, meta = {}, note = "", by, documentId = null, user }) {
		// What the sending module says is owed (meta.amount_due, due_date, statement_date, minimum_payment,
		// reference, vendor, currency): kept, so Create bill needs no LLM.
		const fromMeta = moduleBillInfo(meta);
		const email = { subject: note || filename, from: `module:${sender}`, messageId: null, text: note, attachments: [{ filename, contentType, data }] };
		const accounts = await accountsByCode();
		const given = typeof meta.account_code === "string" && meta.account_code ? accounts.get(meta.account_code) : null;
		if (typeof meta.account_code === "string" && meta.account_code && !given?.is_active) throw bad(`account ${meta.account_code} doesn't exist or is inactive`);
		const isPdf = /\.pdf$/i.test(filename) || data.subarray(0, 5).toString("latin1") === "%PDF-";
		const document = documentId !== null ? { documentId, type: isPdf ? "application/pdf" : contentType || "text/csv", size: data.length } : { data, type: isPdf ? "application/pdf" : contentType || "text/csv" };
		// Read once: what Ledger keeps of this document (parsed here before, or read by the sender), else the parser.
		const parsed = await h.readStatement({ documentId, filename, dateOrder: ["mdy", "dmy"].includes(meta.date_order) ? meta.date_order : "auto", text: isPdf ? null : () => data.toString("utf8") });
		if (parsed) {
			const flip = typeof meta.flip_signs === "boolean" ? meta.flip_signs : parsed.fromExtraction ? parsed.flipped : shouldFlip(given, parsed);
			if (given) return h.stageStatement(parsed, { document, filename, account: given, flip, uploadedBy: by, user, source: "module", billInfo: fromMeta });
			return stageEmailStatement(parsed, { document, filename, email, hint: accountHint(isPdf ? "" : data.toString("utf8"), note), source: "module", uploadedBy: by, user, billInfo: fromMeta });
		}
		const ai = await h.ai();
		if (!ai.readsPdf) throw bad("Ledger's LLM connection for images and documents can't read PDFs (Settings → LLM API); send the CSV or OFX export instead");
		const bankish = bankFirst((await ctx.ledger.listAccounts()).filter((a) => (a.type === "asset" || a.type === "liability") && pickable(a)));
		const r = await extractPdfStatement({ llm: ai.llm, email, pdf: { filename, data }, accounts: bankish });
		if (r.transactions.length === 0) throw bad("no transactions found in this PDF");
		const read = { format: "pdf", transactions: r.transactions, warnings: [] };
		// The balance was read in the same call as the transactions: Create bill uses it without asking again.
		const billInfo = fromMeta ?? billInfoOf(r.balance, "pdf");
		// What the AI read waits with the statement; it is saved with the document once a person posts from it.
		const owed = billInfoData(billInfo);
		const reading = statementData(read, { accountHint: r.account_hint });
		const aiReading = { ...reading, ...(owed?.data ?? {}), [MODULE_KEY]: { ...reading[MODULE_KEY], ...(owed?.mine ?? {}), read_by: "ai" } };
		const staged = given
			? await h.stageStatement(read, { document, filename, account: given, flip: false, uploadedBy: by, user, source: "module", billInfo, aiReading })
			: await stageEmailStatement(read, { document, filename, email, hint: r.account_hint || accountHint(note), guess: r.account_code, source: "module", uploadedBy: by, user, billInfo, aiReading });
		return { ...staged, ai: true };
	}

	ctx.route("PATCH", "/bills/:id", async (req) => {
		const bill = await getBill(req.params.id);
		const b = req.body ?? {};
		const f = await billFields(b, bill);
		if (b.status !== undefined) {
			if (!["new", "open", "ignored", "paid"].includes(b.status)) throw bad("status must be new, open, ignored or paid");
			if (bill.journal_entry_id && b.status === "ignored") throw new ctx.HttpError(409, "undo the approval before ignoring this bill");
			// Its linked payments cover it: Ledger says it is paid, and a tag set against that would not hold.
			if (bill.status === "paid" && b.status !== "paid" && tags.managed(bill)) {
				const p = await tags.payments(bill.journal_entry_id);
				if (p && p.status === "paid") throw new ctx.HttpError(409, `the payments linked to this ${bill.kind}'s entry #${bill.journal_entry_id} in Ledger cover it; take one off there (or reverse it) to make it unpaid`);
			}
			f.status = b.status;
			if (b.status === "paid" && bill.status !== "paid") f.paid_at = new Date();
			// Marked paid or reopened by a person here: no longer "paid because its entry was tagged".
			if (b.status !== bill.status && (bill.paid_by_tag || bill.paid_tag_by)) Object.assign(f, { paid_by_tag: false, paid_tag_by: null });
		}
		const standin = !!(bill.standin_account_code && bill.journal_entry_id);
		if (standin && "vendor" in f && !f.vendor) throw new ctx.HttpError(409, "this bill is posted to its vendor's own account; give it another vendor, or undo the approval first");
		// Given another account by a person (only while it isn't posted): an ordinary bill from then on.
		if (bill.standin_account_code && "account_code" in f && f.account_code !== bill.account_code) f.standin_account_code = null;
		await applyFields(bill.id, f, req.user.username);
		if ("amount_cents" in f || "account_code" in f || "tax_id" in f) await rebook(bill.id);
		// A person saved the vendor or customer: it belongs in Ledger's list of customers and vendors.
		if ("vendor" in f || "customer_name" in f) await linkEntities(bill.id, { create: true });
		if (f.status === "ignored" || f.amount_cents !== undefined || f.account_code !== undefined || f.tax_id !== undefined) await unlink(bill.id);
		// The tags on its entry follow (Ledger 0.23.0): reopened, it isn't "paid" any more; a changed
		// vendor replaces the old one; marked paid, it is "paid" (the sync below sets what's missing).
		const after = await getBill(bill.id);
		const entry = tags.billEntry(after);
		if (bill.status === "paid" && after.status !== "paid") {
			await tags.unpaid(after, req.user);
			await h.dtags.clearPaid(bill.id);
		}
		// Mark paid: no payment entry to link, so "paid" is set here (where Ledger keeps the tag, the
		// sync below only follows it).
		if (bill.status !== "paid" && after.status === "paid" && tags.managed(after)) await tags.set(entry, "paid", {}, req.user);
		// The vendor was changed: the bill's entry and the payments posted for it follow. On Ledger 0.31.0
		// that moves their payable lines out of the previous vendor's own account and into the new one's.
		if (bill.vendor_entity_id && String(bill.vendor_entity_id) !== String(after.vendor_entity_id ?? "")) {
			const paid = (await paymentOf(bill.id)).filter((t) => t.status === "posted" && t.journal_entry_id !== null).map((t) => t.journal_entry_id);
			if (standin) {
				// The bill's own entry: its credit line moves straight to the new vendor's account (the
				// stand-in line in accounts payable stays out of it); its payments follow as usual.
				await standinVendorChanged(bill, after, req.user);
				await tags.vendorChanged(bill, { ...after, journal_entry_id: null, paid_entry_id: null }, paid, req.user);
			} else await tags.vendorChanged(bill, after, paid, req.user);
		}
		await tags.syncBill(after, req.user);
		// An approved bill a person corrected: what is kept with its document follows.
		if (Object.keys(f).some((k) => k !== "status")) await saveBillExtraction(bill.id, req.user);
		await autoMatch();
		return getBill(bill.id);
	});

	ctx.route("DELETE", "/bills/:id", async (req) => {
		const bill = await getBill(req.params.id);
		if (bill.journal_entry_id) throw new ctx.HttpError(409, "undo the approval before deleting this bill");
		if ((await paymentOf(bill.id)).some((t) => t.status === "posted")) throw new ctx.HttpError(409, "a posted payment refers to this bill; ignore it instead");
		await unlink(bill.id);
		// Its billable items' rate items come off the entry it was linked to.
		await tags.syncItems({ ...bill, status: "ignored" });
		await h.settleFile?.({ billId: bill.id }, "rejected", `deleted in ${ctx.name} by ${req.user.username}`, req.user.username);
		await h.files.removeBillFile(bill.id);
		await q(`DELETE FROM ${T("bills")} WHERE id = $1`, [bill.id]);
		// A document that stays (someone else filed it, or the inbox still has it) loses what this bill tagged.
		if (bill.document_id != null) await h.dtags.clearBill(bill.document_id);
		await dash.remove(`bill-${bill.id}`);
	});

	// Approve: the details are right. With a payable account (set, or tagged in Ledger), also post the bill or receipt to payables.
	ctx.route("POST", "/bills/:id/approve", (req) => approveBill(req.params.id, req.user));
	async function approveBill(billId, user) {
		const req = { user };
		const bill = await getBill(billId);
		if (!["new", "open"].includes(bill.status)) throw new ctx.HttpError(409, `this bill is ${bill.status}`);
		if (bill.amount_cents === null) throw bad("enter the amount first");
		if (!bill.account_code) throw bad("choose the account first");
		// Approving confirms the vendor the AI read: link (or add) it in Ledger's list.
		await linkEntities(bill.id, { create: true });
		const vendorEntity = (await getBill(bill.id)).vendor_entity_id;
		// A person approved the details: the filed document gets them too.
		await h.files.updateBillDocument(bill.id, {
			kind: bill.kind === "receipt" ? "receipt" : "invoice",
			title: `${bill.vendor || "Bill"}${bill.invoice_number ? ` ${bill.invoice_number}` : ""}`.slice(0, 200),
			...(bill.bill_date || bill.due_date ? { doc_date: bill.bill_date ?? bill.due_date } : {}),
			...(vendorEntity ? { entity_id: Number(vendorEntity) } : {}),
		});
		const mail = await billSettings();
		let accounts = await accountsByCode();
		const apCode = payableOf(mail, accounts, bill.currency);
		// A bill from a statement whose debit is the stand-in in accounts payable: its credit goes to the
		// vendor's own account, by its code. Where that can't be any more (no vendor on Ledger's list,
		// no accounts payable, an older Ledger), it goes through the clearing account instead.
		let own = null;
		if (bill.standin_account_code && !bill.journal_entry_id) {
			own = await standinOwnAccount({ ...bill, vendor_entity_id: vendorEntity }, apCode);
			const debit = own ? apCode : (await statementBillsAccount(bill.currency)).code;
			if (debit !== bill.account_code || (own ? apCode : null) !== bill.standin_account_code) {
				await applyFields(bill.id, { account_code: debit, standin_account_code: own ? apCode : null }, req.user.username);
				Object.assign(bill, { account_code: debit, standin_account_code: own ? apCode : null });
			}
			accounts = await accountsByCode();
		}
		const account = accounts.get(bill.account_code);
		if (account?.currency !== bill.currency) throw bad(`account ${bill.account_code} is in ${account?.currency}, the bill in ${bill.currency}`);
		if (apCode && !bill.journal_entry_id) {
			const ap = accounts.get(apCode);
			if (!ap || !ap.is_active || ap.type !== "liability") {
				throw new ctx.HttpError(409, `the accounts payable account "${apCode}" under Settings → ${ctx.name} must be an active liability account`);
			}
			if (ap.currency !== bill.currency) throw bad(`the payable account ${apCode} is in ${ap.currency}, not ${bill.currency}; bills in ${bill.currency} can't be posted to it`);
			// One vendor's own account can't be accounts payable for every bill.
			if (ap.entity) throw new ctx.HttpError(409, `the accounts payable account "${apCode}" under Settings → ${ctx.name} is ${ap.entity.name}'s own account; choose accounts payable itself, or none`);
			if (!own && bill.account_code === ap.code) throw new ctx.HttpError(409, `account ${ap.code} is accounts payable itself; choose the account this ${bill.kind} is for`);
			const date = bill.bill_date ?? bill.due_date ?? today();
			const splitLines = own ? [] : await linesOf(bill.id);
			const entry = await ctx.ledger.createJournalEntry(
				{
					entry_date: date,
					description: `${bill.vendor || (bill.kind === "receipt" ? "Receipt" : "Bill")}${bill.invoice_number ? ` ${bill.kind === "receipt" ? "receipt" : "invoice"} ${bill.invoice_number}` : ` ${bill.kind}`}`.slice(0, 500),
					reference: (bill.invoice_number ? `${bill.kind} ${bill.invoice_number}` : `${bill.kind} ${bill.id}`).slice(0, 100),
					lines: [
						...(splitLines.length > 0
							? splitLines.map((l) => ({ account_code: l.account_code, debit_cents: l.amount_cents, credit_cents: 0n, memo: l.description.slice(0, 500) }))
							: [{ account_code: bill.account_code, debit_cents: bill.amount_cents, credit_cents: 0n, memo: own ? `Statement balance${bill.due_date ? `, due ${bill.due_date}` : ""}` : bill.due_date ? `due ${bill.due_date}` : "" }]),
						// The stand-in: the credit names the vendor's own account, so Ledger posts the entry as
						// written (it leaves an entry between accounts payable and the vendor's account alone).
						{ account_code: own ? own.code : ap.code, debit_cents: 0n, credit_cents: bill.amount_cents, memo: "" },
					],
					links: [billLink(bill)],
					// With its vendor: Ledger 0.31.0 then posts the line for the account tagged "Accounts payable"
					// to the vendor's own account under it (the entry it returns says which). A line for another
					// account chosen under Settings stays there, as chosen.
					...(vendorEntity ? { entity_id: Number(vendorEntity) } : {}),
				},
				req.user,
			);
			// ap_account: the account the bill went through (what its payment rows are offered); where the line sits is read from the entry.
			// The stand-in line's number, to move it when the statement row is linked.
			const at = own ? (entry.lines ?? []).findIndex((l) => l.account_code === ap.code && BigInt(String(l.debit_cents ?? 0)) > 0n) : -1;
			await q(`UPDATE ${T("bills")} SET journal_entry_id = $2, ap_account = $3, standin_line = $4, standin_tx_id = NULL WHERE id = $1`, [bill.id, entry.id, ap.code, at < 0 ? null : lineNumber(entry.lines[at], at)]);
			// From here Ledger's linked payments say what is paid of it (0.33.0). Payments posted for it
			// before (its approval was undone and it is approved again) are linked to the new entry.
			if (tags.paymentsOn) await tags.linkBillPayments(await getBill(bill.id), req.user);
		}
		await applyFields(bill.id, { status: bill.status === "new" ? "open" : bill.status, error: null }, req.user.username);
		// Its entry says who it is with, "unpaid" (Ledger 0.33.0, which keeps partially_paid and paid from
		// the payments linked later) and "overdue" when it already is (Ledger 0.23.0).
		await tags.syncBill(await getBill(bill.id), req.user);
		// A person approved what was read: it is saved with the document (Ledger's extracted data), for every module.
		await saveBillExtraction(bill.id, req.user);
		await autoMatch();
		// A person approved what the AI read: the file it came from (if another module sent it) is done.
		await h.settleFile?.({ billId: bill.id }, "done", `approved as ${bill.kind} #${bill.id} by ${req.user.username}`, req.user.username);
		return getBill(bill.id);
	}

	ctx.route("POST", "/bills/:id/unapprove", async (req) => {
		const bill = await getBill(req.params.id);
		if (bill.status === "paid") throw new ctx.HttpError(409, "this bill is paid; reverse the payment entry in the journal first");
		// The payment on the card's or loan's statement was linked: its line goes back to accounts payable
		// first and the row waits to be posted again, so the reversal undoes the entry as it was posted.
		if (bill.journal_entry_id && bill.standin_tx_id != null) await unlinkStandin(bill, req.user, "the bill's approval is undone");
		// Rows posted as their own entries to clear its stand-in (0.30.0): those entries are reversed and the rows wait again.
		const freed = bill.journal_entry_id && bill.standin_account_code ? await unlinkStandinRows(bill, req.user, null, "the bill's approval is undone; unlinked") : [];
		if (bill.journal_entry_id) {
			// The payments linked to the entry in Ledger come off it: it is no longer a bill to pay.
			if (tags.managed(bill)) for (const x of (await tags.payments(bill.journal_entry_id))?.payments ?? []) await tags.unlinkPayment(bill.journal_entry_id, x.entry_id, req.user);
			await ctx.ledger.reverseJournalEntry(bill.journal_entry_id, { description: `Undo ${bill.vendor || "bill"} bill approval`.slice(0, 500) }, req.user);
			// The reversed entry is no longer a bill to pay: not "overdue", not "paid", "partially_paid" or "unpaid".
			await tags.clearStatus(bill.journal_entry_id);
			await q(`UPDATE ${T("bills")} SET journal_entry_id = NULL, ap_account = NULL, standin_line = NULL, standin_tx_id = NULL, payments_linked_at = NULL WHERE id = $1`, [bill.id]);
		}
		await applyFields(bill.id, { status: "new" }, req.user.username);
		await unlink(bill.id);
		// The reversed entry doesn't carry its items any more.
		await tags.syncItems(await getBill(bill.id), req.user);
		await autoMatch();
		if (freed.length > 0) await h.rowsChanged?.(freed, req.user);
		return getBill(bill.id);
	});

	// Unposted outgoing statement transactions to link by hand, going by what is still to pay after
	// the ones already linked: those for exactly that, then larger ones dated near the bill (offered
	// with a split, split: true) and smaller ones (partial payments, partial: true).
	ctx.route("GET", "/bills/:id/candidates", async (req) => {
		const bill = await getBill(req.params.id);
		if (bill.amount_cents === null) return { data: [] };
		const owed = await owedOf(bill);
		if (owed <= 0n) return { data: [], remaining_cents: "0" };
		const neg = (-owed).toString();
		const free = `t.status = 'new' AND t.bill_id IS NULL AND t.transfer_tx_id IS NULL AND t.transfer_entry_id IS NULL`;
		const cols = `t.id, t.statement_id, t.account_code, t.tx_date::text AS date, t.description, t.amount_cents, t.bill_id`;
		const { rows } = await q(
			`SELECT ${cols}, false AS split, false AS partial
			   FROM ${T("transactions")} t WHERE t.status = 'new' AND t.amount_cents = $1 AND t.bill_id IS DISTINCT FROM $2 ORDER BY t.tx_date DESC LIMIT 50`,
			[neg, bill.id],
		);
		const near = String(bill.bill_date || bill.due_date || new Date().toISOString().slice(0, 10)).slice(0, 10);
		const { rows: larger } = await q(
			`SELECT ${cols}, true AS split, false AS partial
			   FROM ${T("transactions")} t
			  WHERE ${free} AND t.amount_cents < $1
			    AND t.tx_date BETWEEN $2::date - 7 AND $2::date + 45
			  ORDER BY abs(t.tx_date - $2::date), t.amount_cents DESC LIMIT 15`,
			[neg, near],
		);
		const { rows: smaller } = await q(
			`SELECT ${cols}, false AS split, true AS partial
			   FROM ${T("transactions")} t
			  WHERE ${free} AND t.amount_cents > $1 AND t.amount_cents < 0
			    AND t.tx_date BETWEEN $2::date - 7 AND $2::date + 45
			  ORDER BY abs(t.tx_date - $2::date), t.amount_cents LIMIT 15`,
			[neg, near],
		);
		return { data: [...rows, ...larger, ...smaller], remaining_cents: owed.toString() };
	});

	ctx.route("POST", "/bills/:id/match", async (req) => {
		const bill = await getBill(req.params.id);
		const txId = String(req.body?.transaction_id ?? "");
		if (!/^\d+$/.test(txId)) throw bad("transaction_id is required");
		const split = req.body?.split;
		if (split !== undefined && split !== null && (typeof split !== "object" || Array.isArray(split))) throw bad("split must be {lines: [{amount, account_code, memo}]}");
		await matchBillTx(bill, txId, "matched by hand", split ?? null);
		return { bill: await getBill(bill.id), payments: await paymentOf(bill.id) };
	});

	/**
	 * Links an unposted statement row to a bill as its payment (by hand, or an approved match), beside
	 * the rows already linked: several rows can pay one bill, each a part of it. A row for less than
	 * what is still to pay is a partial payment. With split, a row for more pays what is still to pay
	 * and the rest is booked, when the row is posted, to the accounts of split.lines ([{amount,
	 * account_code, memo}], adding up to the rest), or all of it to split.account_code (one line).
	 */
	async function matchBillTx(bill, txId, how, split = null) {
		const target = targetOf(bill);
		if (!target) throw bad("choose the bill's account first");
		if (!["new", "open"].includes(bill.status)) throw new ctx.HttpError(409, `this ${bill.kind} is ${bill.status}`);
		if (bill.paid_entry_id) throw new ctx.HttpError(409, `this ${bill.kind} is already linked to journal entry #${bill.paid_entry_id}`);
		const { rows: tx } = await q(`SELECT amount_cents, status FROM ${T("transactions")} WHERE id = $1`, [String(txId)]);
		if (tx.length === 0 || tx[0].status !== "new") throw bad("that transaction is not waiting to be posted");
		const out = -BigInt(tx[0].amount_cents);
		// What is still to pay after the other transactions linked to it.
		const owed = await owedOf(bill, txId);
		if (owed !== null && owed <= 0n) throw new ctx.HttpError(409, `the transactions linked to this ${bill.kind} already cover its ${formatCents(BigInt(bill.amount_cents))}; unlink one first`);
		let rest = null;
		if (split) {
			if (owed === null) throw bad(`enter the ${bill.kind}'s amount first`);
			const left = out - owed;
			if (left <= 0n) throw bad(`only a payment larger than what is still to pay on the ${bill.kind} can be split`);
			const input = split.lines === undefined ? [{ amount: left, account_code: split.account_code, memo: split.memo }] : split.lines;
			if (!Array.isArray(input) || input.length < 1 || input.length > 20) throw bad("split.lines must be a list of 1 to 20 lines");
			const accounts = await accountsByCode();
			const lines = input.map((l, i) => {
				const at = `split line ${i + 1}`;
				if (!l || typeof l !== "object") throw bad(`${at}: must be {amount, account_code, memo}`);
				const amount = typeof l.amount === "bigint" ? l.amount : parseAmount(typeof l.amount === "number" ? l.amount.toFixed(2) : String(l.amount ?? ""));
				if (amount === null || amount <= 0n) throw bad(`${at}: amount must be above zero`);
				const a = accounts.get(String(l.account_code ?? ""));
				if (!a || !a.is_active || !pickable(a)) throw bad(input.length === 1 ? "choose the account for the rest of the transaction" : `${at}: choose an active account`);
				if (a.currency !== bill.currency) throw bad(`${at}: account ${a.code} is in ${a.currency}, the ${bill.kind} in ${bill.currency}`);
				if (l.memo !== undefined && l.memo !== null && typeof l.memo !== "string") throw bad(`${at}: memo must be text`);
				return { amount, code: a.code, memo: String(l.memo ?? "").trim().slice(0, 500) };
			});
			const sum = lines.reduce((t, l) => t + l.amount, 0n);
			if (sum !== left) throw bad(`the split lines add up to ${formatCents(sum)}, but ${formatCents(left)} of the transaction is left after the ${bill.kind}'s ${formatCents(owed)}`);
			rest = { cents: left.toString(), code: lines[0].code, memo: lines[0].memo, lines };
		}
		const reason = `pays ${bill.vendor || "bill"}${owed !== null && out < owed ? " in part" : ""} (${how})${rest ? `; ${formatCents(BigInt(rest.cents))} split to ${[...new Set(rest.lines.map((l) => l.code))].join(", ")}` : ""}`;
		const { rowCount } = await q(
			`UPDATE ${T("transactions")} SET bill_id = $2, chosen_code = $3, source = 'bill', reason = $4, error = NULL,
			        split_cents = $5, split_account_code = $6, split_memo = $7
			  WHERE id = $1 AND status = 'new'`,
			[String(txId), bill.id, target, reason.slice(0, 200), rest?.cents ?? null, rest?.code ?? null, rest?.memo ?? ""],
		);
		if (rowCount === 0) throw bad("that transaction is not waiting to be posted");
		await q(`DELETE FROM ${T("transaction_splits")} WHERE transaction_id = $1`, [String(txId)]);
		if (rest) {
			await q(
				`INSERT INTO ${T("transaction_splits")} (transaction_id, line_no, amount_cents, account_code, memo)
				 SELECT $1, u.n, u.a, u.c, u.m FROM unnest($2::int[], $3::bigint[], $4::text[], $5::text[]) AS u(n, a, c, m)`,
				[String(txId), rest.lines.map((_, i) => i + 1), rest.lines.map((l) => l.amount.toString()), rest.lines.map((l) => l.code), rest.lines.map((l) => l.memo)],
			);
		}
		// The vendor chosen on the bill is the one its payment is tagged with when it's posted.
		await vendorOf(bill.id);
		await syncBillTodos();
	}

	/**
	 * The bill or receipt is already in the journal (entered by hand, or by another module): link it
	 * to that entry and count it as paid. Its unposted payment rows are unlinked.
	 */
	async function linkBillEntry(given, entryId, user) {
		let bill = given;
		if (bill.status === "paid") throw new ctx.HttpError(409, `this ${bill.kind} is already ${bill.kind === "receipt" ? "matched" : "paid"}`);
		const e = await ctx.ledger.getJournalEntry(Number(entryId)).catch(() => null);
		if (!e) throw new ctx.HttpError(404, `no journal entry ${entryId}`);
		if (e.reversed_by_id != null || e.reverses_id != null) throw new ctx.HttpError(409, `entry #${e.id} is reversed or a reversal`);
		if (bill.journal_entry_id && String(bill.journal_entry_id) === String(e.id)) throw new ctx.HttpError(409, `entry #${e.id} is this ${bill.kind}'s own entry; link the entry that paid it`);
		await unlink(bill.id);
		await vendorOf(bill.id);
		// A bill with an entry of its own: the entry that paid it is linked to that one in Ledger as its
		// payment (0.33.0), for what is still to pay of it; Ledger then tags the bill's entry paid.
		bill = await ensureLinked(bill, user);
		if (tags.managed(bill)) {
			const p = await tags.payments(bill.journal_entry_id);
			const rest = p ? p.left_cents : bill.amount_cents == null ? null : BigInt(bill.amount_cents);
			if (rest !== null && rest <= 0n) throw new ctx.HttpError(409, `the payments linked to this ${bill.kind}'s entry in Ledger already cover it`);
			await tags.linkPayment(bill.journal_entry_id, e.id, rest, `payment of ${bill.kind} ${bill.vendor || `#${bill.id}`}${bill.invoice_number ? ` ${bill.invoice_number}` : ""}, linked by hand (${ctx.name})`, user, { strict: true });
		}
		await q(`UPDATE ${T("bills")} SET status = 'paid', paid_entry_id = $2, paid_at = now(), paid_by_tag = false, paid_tag_by = NULL, updated_by = $3, updated_at = now() WHERE id = $1`, [bill.id, e.id, user.username]);
		await ctx.ledger.linkJournalEntry(e.id, billLink(bill), user);
		// A person said this entry records it: the bill's entry is "paid" and with its vendor.
		const linked = await getBill(bill.id);
		await tags.syncBill(linked, user);
		// The entry it was linked to is with that vendor too (it isn't the bill's own entry when the bill went through payables).
		if (linked.vendor_entity_id) await tags.tagWho(e, "vendor", linked.vendor_entity_id, user);
		await dash.complete(`bill-${bill.id}`);
		await syncBillTodos();
		ctx.log.info("bill linked to journal entry", { bill: String(bill.id), entry: e.id, by: user.username });
		return getBill(bill.id);
	}

	// POST /bills/:id/link-entry {entry_id}: it's already in the journal. /unlink-entry undoes that.
	ctx.route("POST", "/bills/:id/link-entry", async (req) => {
		const bill = await getBill(req.params.id);
		const id = Number(req.body?.entry_id);
		if (!Number.isSafeInteger(id) || id <= 0) throw bad("entry_id must be a journal entry id");
		return linkBillEntry(bill, id, req.user);
	});
	ctx.route("POST", "/bills/:id/unlink-entry", async (req) => {
		const bill = await getBill(req.params.id);
		// Linked by hand: the entry that completed it isn't one of its statement rows' (rows posted before, each a part payment, stay).
		if (!bill.paid_entry_id || (await paymentOf(bill.id)).some((t) => t.status === "posted" && String(t.journal_entry_id) === String(bill.paid_entry_id))) throw new ctx.HttpError(409, "this isn't linked to a journal entry by hand");
		await ctx.ledger.unlinkJournalEntry(bill.paid_entry_id, `bill:${bill.id}`).catch(() => false);
		// Not paid after all. Linked in Ledger as the payment of the bill's entry (0.33.0): that link is
		// taken off, and Ledger tags the entry unpaid or partially paid again. Else the payable entry
		// loses "paid"; an entry that only recorded it loses what this module tagged.
		const byLedger = tags.managed(bill);
		if (byLedger) await tags.unlinkPayment(bill.journal_entry_id, bill.paid_entry_id, req.user);
		await q(`UPDATE ${T("bills")} SET status = 'open', paid_entry_id = NULL, paid_at = NULL, updated_by = $2, updated_at = now() WHERE id = $1`, [bill.id, req.user.username]);
		if (byLedger) await tags.unpaid(await getBill(bill.id), req.user);
		else if (bill.journal_entry_id) await tags.remove(bill.journal_entry_id, "paid");
		else await tags.clearLinked(bill.paid_entry_id, bill.vendor_entity_id);
		await h.dtags.clearPaid(bill.id);
		await tags.syncItems(await getBill(bill.id), req.user);
		await autoMatch();
		return getBill(bill.id);
	});

	// POST /bills/:id/link-statement-row {transaction_id}: the payment on the card's or loan's own statement
	// is this bill's. The row is posted as its own entry, Dr that account / Cr accounts payable where the
	// bill's stand-in is, linked to the bill's entry, which stays as posted (Ledger 0.33.0; a part of the
	// amount is fine). /unlink-statement-row {transaction_id?} reverses that entry and the row waits to be
	// posted again (every linked row, without transaction_id). On Ledger 0.32.x, and for a bill linked by
	// 0.29.0, the stand-in line is moved to the account and back instead.
	ctx.route("POST", "/bills/:id/link-statement-row", async (req) => {
		const bill = await getBill(req.params.id);
		const txId = String(req.body?.transaction_id ?? "");
		if (!/^\d+$/.test(txId)) throw bad("transaction_id is required");
		return linkStandin(bill, txId, req.user);
	});
	ctx.route("POST", "/bills/:id/unlink-statement-row", async (req) => {
		const bill = await getBill(req.params.id);
		const one = req.body?.transaction_id;
		if (one !== undefined && one !== null && !/^\d+$/.test(String(one))) throw bad("transaction_id must be a transaction's id");
		// Linked the 0.29.0 way (its line was moved): the line goes back.
		if (bill.standin_tx_id != null && (one == null || String(one) === String(bill.standin_tx_id))) return unlinkStandin(bill, req.user);
		const freed = await unlinkStandinRows(bill, req.user, one ?? null);
		if (freed.length === 0) throw new ctx.HttpError(409, one == null ? "this bill isn't linked to a payment on its card's or loan's statement" : `transaction ${one} isn't linked to this bill's stand-in`);
		await q(`UPDATE ${T("bills")} SET updated_by = $2, updated_at = now() WHERE id = $1`, [bill.id, req.user.username]);
		await autoMatch();
		await h.rowsChanged?.(freed, req.user);
		return getBill(bill.id);
	});

	ctx.route("POST", "/bills/:id/unmatch", async (req) => {
		const bill = await getBill(req.params.id);
		// One of its transactions (transaction_id), or all of them.
		const one = req.body?.transaction_id;
		if (one !== undefined && one !== null && !/^\d+$/.test(String(one))) throw bad("transaction_id must be a transaction's id");
		const only = one == null ? null : String(one);
		await q(`UPDATE ${T("transactions")} SET chosen_code = NULL WHERE bill_id = $1 AND status = 'new' AND chosen_code = $2 AND ($3::bigint IS NULL OR id = $3)`, [bill.id, targetOf(bill), only]);
		await q(`UPDATE ${T("transactions")} SET rejected_bill_id = bill_id WHERE bill_id = $1 AND status = 'new' AND ($2::bigint IS NULL OR id = $2)`, [bill.id, only]);
		await unlink(bill.id, only);
		await syncBillTodos();
		return { bill: await getBill(bill.id), payments: await paymentOf(bill.id) };
	});

	// -----------------------------------------------------------------------
	// Split lines (a receipt for groceries and household supplies, ...)
	// -----------------------------------------------------------------------

	async function linesOf(billId) {
		const { rows } = await q(`SELECT line_no, description, amount_cents, account_code FROM ${T("bill_lines")} WHERE bill_id = $1 ORDER BY line_no`, [String(billId)]);
		return rows;
	}

	/** Whether the bill's lines can still change: nothing it books is posted yet. */
	async function assertSplittable(bill) {
		if (bill.journal_entry_id) throw new ctx.HttpError(409, "this bill is posted to payables; undo the approval first");
		if (bill.paid_entry_id || (await paymentOf(bill.id)).some((t) => t.status === "posted")) throw new ctx.HttpError(409, `this ${bill.kind} is already ${bill.kind === "receipt" ? "matched to a posted payment" : "paid"}`);
	}

	/** The bill's document for the LLM: { text, pdf?, image? }. */
	async function documentOf(bill, ai) {
		const { rows } = await q(`SELECT body_text FROM ${T("bills")} WHERE id = $1`, [bill.id]);
		const f = await h.files.readBillFile(bill.id);
		const d = { body_text: rows[0]?.body_text ?? "", document: f?.data ?? null, document_type: f?.type ?? null };
		const doc = { text: d.body_text || "" };
		if (d.document && d.document_type === "application/pdf" && ai.readsPdf) doc.pdf = d.document;
		else if (d.document && /^image\//.test(d.document_type ?? "") && ai.readsImages) doc.image = { data: d.document, contentType: d.document_type };
		return doc;
	}

	// -----------------------------------------------------------------------
	// Line items (what was bought: description, quantity, unit, price), read when the document is
	// scanned. Billable ones are rate items on the bill's journal entry (lib/tags.mjs syncItems).
	// -----------------------------------------------------------------------

	async function itemsOf(billId) {
		const { rows } = await q(
			`SELECT id, line_no, description, quantity::text AS quantity, unit, rate_cents, amount_cents, billable, rate_entry_id, rate_tag_id, account_code, tax_id, suggested_tax_id, no_tax
			   FROM ${T("bill_items")} WHERE bill_id = $1 ORDER BY line_no`,
			[String(billId)],
		);
		const taxes = rows.some((r) => r.tax_id !== null) ? await h.taxes.taxesById() : new Map();
		return rows.map((r) => ({ ...r, quantity: r.quantity === null ? null : String(Number(r.quantity)), tax_id: r.tax_id === null ? null : String(r.tax_id), suggested_tax_id: r.suggested_tax_id === null ? null : String(r.suggested_tax_id), tax: taxOf(taxes.get(String(r.tax_id))) }));
	}

	/** The taxes the AI may propose on line items: the ones in use. */
	const activeTaxes = async () => (await h.taxes.listTaxes()).filter((t) => t.active);

	/** A tax as an item carries it (what linesFromItems needs), or null. */
	const taxOf = (t) => (t ? { id: t.id, name: t.name, rate: t.rate, account_code: t.account_code } : null);

	/** Adds line items (normalizeItem's) after the bill's existing ones. */
	async function insertItems(billId, items) {
		if (!items.length) return;
		await q(
			`INSERT INTO ${T("bill_items")} (bill_id, line_no, description, quantity, unit, rate_cents, amount_cents, billable, suggested_tax_id)
			 SELECT $1, COALESCE((SELECT max(line_no) FROM ${T("bill_items")} WHERE bill_id = $1), 0) + u.n, u.d, u.q, u.u, u.r, u.a, u.b, u.t
			   FROM unnest($2::int[], $3::text[], $4::numeric[], $5::text[], $6::bigint[], $7::bigint[], $8::boolean[], $9::bigint[]) AS u(n, d, q, u, r, a, b, t)`,
			[
				String(billId),
				items.map((_, i) => i + 1),
				items.map((it) => it.description),
				items.map((it) => it.quantity),
				items.map((it) => it.unit ?? ""),
				items.map((it) => (it.rate_cents === null ? null : it.rate_cents.toString())),
				items.map((it) => (it.amount_cents === null ? null : it.amount_cents.toString())),
				items.map((it) => it.billable === true),
				// What the AI proposes; the item's own tax is only set when a person saves the items.
				items.map((it) => it.suggested_tax_id ?? null),
			],
		);
	}

	/** A line item from a request (a person's edit), checked. */
	function itemFromBody(x, i) {
		const at = `item ${i + 1}`;
		if (!x || typeof x !== "object") throw bad(`${at}: must be an object`);
		if (typeof x.description !== "string" || !x.description.trim() || x.description.trim().length > 100) throw bad(`${at}: description must be text of 1 to 100 characters`);
		const given = (v) => v !== undefined && v !== null && v !== "";
		if (given(x.quantity)) {
			const n = Number(typeof x.quantity === "number" ? x.quantity : String(x.quantity).trim());
			if (!Number.isFinite(n) || n <= 0 || n >= 1e12 || Math.round(n * 10000) / 10000 !== n) throw bad(`${at}: quantity must be a positive number with at most 4 decimals`);
		}
		const unit = typeof x.unit === "string" ? x.unit.trim().toLowerCase() : "";
		if (x.unit !== undefined && x.unit !== null && typeof x.unit !== "string") throw bad(`${at}: unit must be text`);
		if (unit && !/^[a-z][a-z0-9 ./_-]{0,19}$/.test(unit)) throw bad(`${at}: unit must be a word of up to 20 characters, e.g. each, hours, kg`);
		for (const k of ["rate", "amount"]) {
			if (!given(x[k])) continue;
			const a = parseAmount(typeof x[k] === "number" ? x[k].toFixed(2) : String(x[k]));
			if (a === null || a < 0n) throw bad(`${at}: ${k} must be an amount of 0 or more`);
		}
		if (x.billable !== undefined && typeof x.billable !== "boolean") throw bad(`${at}: billable must be true or false`);
		if (x.id !== undefined && x.id !== null && !/^\d+$/.test(String(x.id))) throw bad(`${at}: id must be one of the bill's item ids`);
		if (x.account_code !== undefined && x.account_code !== null && typeof x.account_code !== "string") throw bad(`${at}: account_code must be an account's code, or empty for the bill's own`);
		if (x.tax_id !== undefined && x.tax_id !== null && x.tax_id !== "" && x.tax_id !== "none" && !/^\d{1,18}$/.test(String(x.tax_id))) throw bad(`${at}: tax_id must be one of the taxes, "none", or empty for the bill's own`);
		const it = normalizeItem({ description: x.description, quantity: given(x.quantity) ? String(x.quantity) : "", unit, unit_price: given(x.rate) ? x.rate : "", amount: given(x.amount) ? x.amount : "" });
		if (!it) throw bad(`${at}: needs a quantity, a price or an amount`);
		return { ...it, id: x.id == null ? null : String(x.id), billable: x.billable === true, account_code: typeof x.account_code === "string" && x.account_code.trim() ? x.account_code.trim() : null, tax_id: x.tax_id == null || x.tax_id === "" || x.tax_id === "none" ? null : String(x.tax_id), no_tax: x.tax_id === "none" };
	}

	const sameLines = (a, b) => a.length === b.length && a.every((l, i) => l.description === b[i].description && String(l.amount ?? l.amount_cents) === String(b[i].amount ?? b[i].amount_cents) && l.account_code === b[i].account_code);

	async function writeLines(billId, lines, fromItems) {
		await q(`DELETE FROM ${T("bill_lines")} WHERE bill_id = $1`, [billId]);
		if (lines.length) {
			await q(
				`INSERT INTO ${T("bill_lines")} (bill_id, line_no, description, amount_cents, account_code)
				 SELECT $1, u.n, u.d, u.a, u.c FROM unnest($2::int[], $3::text[], $4::bigint[], $5::text[]) AS u(n, d, a, c)`,
				[billId, lines.map((_, i) => i + 1), lines.map((l) => l.description), lines.map((l) => l.amount.toString()), lines.map((l) => l.account_code)],
			);
		}
		await q(`UPDATE ${T("bills")} SET lines_from_items = $2 WHERE id = $1`, [billId, fromItems && lines.length > 0]);
	}

	// PUT /bills/:id/items {items: [{id?, description, quantity, unit, rate, amount, billable}]}: the line
	// items as a person edited them (an empty list removes them). Billable ones go on the bill's journal
	// entry as rate items (description, quantity, unit, rate), when it has one; items no longer
	// billable or removed come off it.
	ctx.route("PUT", "/bills/:id/items", async (req) => {
		const bill = await getBill(req.params.id);
		const input = req.body?.items;
		if (!Array.isArray(input) || input.length > 100) throw bad("items must be a list of up to 100 line items");
		const items = input.map(itemFromBody);
		const existing = await itemsOf(bill.id);
		const byId = new Map(existing.map((it) => [String(it.id), it]));
		for (const it of items) if (it.id !== null && !byId.has(it.id)) throw bad(`item ${it.id} isn't one of this bill's items`);
		// Items with a category or a tax of their own: the bill is booked line by line. Worked out and
		// checked before anything is saved; it can only change while nothing the bill books is posted.
		if (items.some((it) => it.account_code || it.tax_id)) {
			const accounts = await accountsByCode();
			const taxes = await h.taxes.taxesById();
			for (const [i, it] of items.entries()) {
				if (it.account_code) {
					const a = accounts.get(it.account_code);
					if (!a || !a.is_active || !pickable(a)) throw bad(`item ${i + 1}: choose an active account`);
					if (a.currency !== bill.currency) throw bad(`item ${i + 1}: account ${a.code} is in ${a.currency}, the ${bill.kind} in ${bill.currency}`);
				}
				if (!it.tax_id) continue;
				const t = taxes.get(it.tax_id);
				// A tax that was turned off stays on the lines that have it; it can't be newly chosen.
				if (!t || (!t.active && byId.get(it.id ?? "")?.tax_id !== it.tax_id)) throw bad(`item ${i + 1}: choose one of the taxes, or none`);
				if (it.amount_cents === null || it.amount_cents <= 0n) throw bad(`item ${i + 1}: needs an amount above zero to have a tax`);
				const chosenNow = byId.get(it.id ?? "")?.tax_id !== it.tax_id;
				if (t.account_code && chosenNow) {
					const a = accounts.get(t.account_code);
					if (!a || !a.is_active || !pickable(a)) throw bad(`item ${i + 1}: ${t.name}'s account ${t.account_code} can't be used any more; add the tax again with another account`);
				}
				const ta = t.account_code ? accounts.get(t.account_code) : null;
				if (ta && ta.currency !== bill.currency) throw bad(`item ${i + 1}: ${t.name} is booked to ${ta.code}, which is in ${ta.currency}; the ${bill.kind} is in ${bill.currency}`);
				it.tax = taxOf(t);
			}
		}
		const plan = linesFromItems(bill, items);
		if (plan.error) throw bad(plan.error);
		const current = await linesOf(bill.id);
		const booksChange = plan.lines.length > 0 ? !(bill.lines_from_items && sameLines(plan.lines, current)) : bill.lines_from_items === true;
		if (booksChange) await assertSplittable(bill);
		const kept = new Set(items.filter((it) => it.id !== null).map((it) => it.id));
		// Removed ones: their rate items come off the entry first.
		for (const it of existing.filter((x) => !kept.has(String(x.id)))) {
			await tags.dropRate(it.rate_entry_id, it.rate_tag_id);
			await q(`DELETE FROM ${T("bill_items")} WHERE id = $1`, [it.id]);
		}
		await q(`UPDATE ${T("bill_items")} SET line_no = -line_no WHERE bill_id = $1`, [bill.id]);
		for (const [i, it] of items.entries()) {
			const vals = [it.description, it.quantity, it.unit, it.rate_cents === null ? null : it.rate_cents.toString(), it.amount_cents === null ? null : it.amount_cents.toString(), it.billable, i + 1, it.account_code, it.tax_id, it.no_tax];
			if (it.id !== null) await q(`UPDATE ${T("bill_items")} SET description = $2, quantity = $3, unit = $4, rate_cents = $5, amount_cents = $6, billable = $7, line_no = $8, account_code = $9, tax_id = $10, no_tax = $11, suggested_tax_id = NULL WHERE id = $1`, [it.id, ...vals]);
			else await q(`INSERT INTO ${T("bill_items")} (bill_id, description, quantity, unit, rate_cents, amount_cents, billable, line_no, account_code, tax_id, no_tax) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [bill.id, ...vals]);
		}
		if (booksChange) {
			await writeLines(bill.id, plan.lines, true);
			await unlink(bill.id);
		}
		const tagged = await tags.syncItems(bill, req.user);
		await saveBillExtraction(bill.id, req.user);
		ctx.log.info("bill items saved", { bill: String(bill.id), items: items.length, billable: items.filter((it) => it.billable).length, rate_items_set: tagged, by: req.user.username });
		return { bill: await getBill(bill.id), items: await itemsOf(bill.id), lines: await linesOf(bill.id), rate_items: tags.ratesOn };
	});

	// POST /bills/:id/items-draft: the LLM reads the document's line items (for bills scanned before
	// items were read, or to read them again). Nothing is saved: the user edits and saves (PUT items).
	ctx.route("POST", "/bills/:id/items-draft", async (req) => {
		const bill = await getBill(req.params.id);
		const ai = await h.ai();
		const doc = await documentOf(bill, ai);
		if (!doc.pdf && !doc.image && !doc.text.trim()) {
			throw bad(bill.has_document ? "Ledger's LLM connection for images and documents can't read this document; enter the items by hand" : "there's no document to read; enter the items by hand");
		}
		const items = await readItems({ llm: ai.llm, bill, document: doc, taxes: await activeTaxes() });
		return { items: items.map((it) => ({ ...it, billable: false })) };
	});

	// -----------------------------------------------------------------------
	// Import from CSV (Settings → Auto sort, Ledger 0.13.2): open bills and receipts from other software
	// -----------------------------------------------------------------------

	if (ctx.imports?.provide) {
		ctx.imports.provide({
			label: "Bills and receipts",
			description: "Open bills and receipts from other bookkeeping software. They arrive on the Bills and Receipts tabs as Needs review; nothing is posted until you approve them. Bills already here (same vendor and invoice number, or same amount and dates) are skipped.",
			fields: [
				{ key: "vendor", label: "Vendor", required: true },
				{ key: "amount", label: "Amount", type: "money", required: true, help: "The total to pay (or paid, for a receipt)" },
				{ key: "due_date", label: "Due date", type: "date" },
				{ key: "bill_date", label: "Bill date", type: "date" },
				{ key: "invoice_number", label: "Invoice number" },
				{ key: "account", label: "Account", help: "The account it's booked to: code or name" },
				{ key: "kind", label: "Type", help: "bill (to be paid) or receipt (already paid); bill when empty" },
				{ key: "currency", label: "Currency", help: "CAD or USD; CAD when empty" },
				{ key: "customer", label: "Customer" },
				{ key: "billable", label: "Billable to the customer", type: "boolean" },
			],
			async handler(rows, { dryRun, user }) {
				const accounts = [...(await accountsByCode()).values()].filter((a) => a.is_active);
				const byCode = new Map(accounts.map((a) => [a.code.toLowerCase(), a]));
				const byName = new Map(accounts.map((a) => [a.name.trim().toLowerCase(), a]));
				const { rows: existing } = await q(
					`SELECT id, kind, vendor, invoice_number, bill_date::text AS bill_date, due_date::text AS due_date, amount_cents FROM ${T("bills")} WHERE status <> 'ignored'`,
				);
				// The same row imported again (even without an invoice number or dates) is recognised exactly.
				const exact = (b) => [b.kind, b.vendor.trim().toLowerCase(), String(b.amount_cents), b.invoice_number || "", b.bill_date || "", b.due_date || ""].join("|");
				const seen = new Set(existing.filter((b) => b.amount_cents != null).map(exact));
				const errors = [];
				const add = [];
				let skipped = 0;
				for (const r of rows) {
					const vendor = String(r.vendor ?? "").trim().slice(0, 200);
					const amount = Number(r.amount);
					if (!vendor) { errors.push({ row: r._row, message: "vendor is empty" }); continue; }
					if (!Number.isSafeInteger(amount) || amount <= 0) { errors.push({ row: r._row, message: "amount must be more than zero" }); continue; }
					const kindText = String(r.kind ?? "").trim().toLowerCase();
					const kind = !kindText || /^bills?$|^invoices?$/.test(kindText) ? "bill" : /^receipts?$|^paid$/.test(kindText) ? "receipt" : null;
					if (!kind) { errors.push({ row: r._row, message: `type "${r.kind}" isn't bill or receipt` }); continue; }
					const currency = String(r.currency ?? "").trim().toUpperCase() || "CAD";
					if (!["CAD", "USD"].includes(currency)) { errors.push({ row: r._row, message: `currency "${r.currency}" isn't CAD or USD` }); continue; }
					let account = null;
					const acc = String(r.account ?? "").trim().toLowerCase();
					if (acc) {
						account = byCode.get(acc) ?? byName.get(acc) ?? null;
						if (!account) { errors.push({ row: r._row, message: `no active account "${r.account}"` }); continue; }
						if (account.currency !== currency) { errors.push({ row: r._row, message: `account ${account.code} is in ${account.currency}, not ${currency}` }); continue; }
					}
					const bill = {
						kind, vendor, currency, amount_cents: BigInt(amount),
						invoice_number: String(r.invoice_number ?? "").trim().slice(0, 100),
						bill_date: r.bill_date ?? null, due_date: r.due_date ?? null,
						account_code: account?.code ?? null,
						customer_name: String(r.customer ?? "").trim().slice(0, 200),
						billable: r.billable === true,
					};
					// Already here (or twice in the file): skipped, so importing the same file again adds nothing.
					if (seen.has(exact(bill)) || findDuplicate(bill, [...existing, ...add])) { skipped++; continue; }
					seen.add(exact(bill));
					add.push({ ...bill, id: `new-${add.length}` });
				}
				const what = (n) => `${n} bill${n === 1 ? "" : "s"} and receipt${n === 1 ? "" : "s"}`;
				const skippedNote = skipped ? `; ${skipped} already here (skipped)` : "";
				if (dryRun || errors.length) return { summary: `Would add ${what(add.length)}${skippedNote}.`, errors };
				for (const b of add) {
					await q(
						`INSERT INTO ${T("bills")} (kind, vendor, invoice_number, bill_date, due_date, amount_cents, currency, account_code, customer_name, billable, source, summary, updated_by)
						 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'import', 'imported from CSV', $11) RETURNING id`,
						[b.kind, b.vendor, b.invoice_number, b.bill_date, b.due_date, b.amount_cents.toString(), b.currency, b.account_code, b.customer_name, b.billable, user.username],
					).then(({ rows: ins }) => linkEntities(ins[0].id, { create: true }));
				}
				await autoMatch();
				ctx.log.info("bills imported", { added: add.length, skipped, by: user.username });
				return { summary: `Added ${what(add.length)} for review on the Bills and Receipts tabs${skippedNote}.` };
			},
		});
	}

	// GET /customers: customer names used on bills and receipts (the page adds the Sales module's).
	ctx.route("GET", "/customers", async () => {
		// Ledger's customers (shared by every module), then names typed on bills before 0.9.0.
		const shared = ctx.entities ? await ctx.entities.list({ role: "customer" }) : [];
		const { rows } = await q(
			`SELECT DISTINCT ON (lower(customer_name)) customer_name, customer_ref FROM ${T("bills")} WHERE customer_name <> '' ORDER BY lower(customer_name), updated_at DESC LIMIT 500`,
		);
		const names = new Set(shared.map((e) => e.name.toLowerCase()));
		return { data: [...shared.map((e) => ({ customer_name: e.name, entity_id: e.id })), ...rows.filter((r) => !names.has(r.customer_name.toLowerCase()))] };
	});

	// GET /vendors: Ledger's vendors, to pick from when typing a bill's vendor.
	ctx.route("GET", "/vendors", async () => ({ data: ctx.entities ? (await ctx.entities.list({ role: "vendor" })).map((e) => ({ name: e.name, entity_id: e.id })) : [] }));

	// POST /bills/:id/split-draft: the LLM reads the document and proposes lines (nothing is saved).
	ctx.route("POST", "/bills/:id/split-draft", async (req) => {
		const bill = await getBill(req.params.id);
		await assertSplittable(bill);
		const ai = await h.ai();
		const doc = await documentOf(bill, ai);
		if (!doc.pdf && !doc.image && !doc.text.trim()) {
			throw bad(bill.has_document ? "Ledger's LLM connection for images and documents can't read this document; enter the lines by hand" : "there's no document to read; enter the lines by hand");
		}
		const accounts = (await ctx.ledger.listAccounts()).filter((a) => a.currency === bill.currency && pickable(a) && !["asset", "liability", "equity"].includes(a.type) && a.code !== bill.ap_account);
		const r = await suggestSplit({ llm: ai.llm, bill, document: doc, accounts, examples: await pastVendors() });
		const sum = r.lines.reduce((t, l) => t + l.amount_cents, 0n);
		return {
			lines: r.lines.map((l) => ({ ...l, account_code: l.account_code ?? bill.account_code })),
			total_cents: r.total_cents,
			sum_cents: sum,
			matches_amount: bill.amount_cents != null && sum === BigInt(bill.amount_cents),
			confidence: r.confidence,
		};
	});

	// PUT /bills/:id/lines {lines: [{description, amount, account_code}]}: save a split (adds up to the amount).
	ctx.route("PUT", "/bills/:id/lines", async (req) => {
		const bill = await getBill(req.params.id);
		await assertSplittable(bill);
		const input = req.body?.lines;
		if (!Array.isArray(input) || input.length < 2 || input.length > 50) throw bad("lines must be 2 to 50 lines; to undo a split, DELETE /bills/:id/lines");
		if (bill.amount_cents == null) throw bad("enter the amount first");
		const accounts = await accountsByCode();
		const lines = input.map((l, i) => {
			const amount = parseAmount(typeof l?.amount === "number" ? l.amount.toFixed(2) : String(l?.amount ?? ""));
			if (amount === null || amount <= 0n) throw bad(`line ${i + 1}: amount must be a positive amount`);
			const a = accounts.get(String(l?.account_code ?? ""));
			if (!a || !a.is_active || !pickable(a)) throw bad(`line ${i + 1}: choose an active account`);
			if (a.currency !== bill.currency) throw bad(`line ${i + 1}: account ${a.code} is in ${a.currency}, the ${bill.kind} in ${bill.currency}`);
			if (typeof (l.description ?? "") !== "string") throw bad(`line ${i + 1}: description must be text`);
			return { description: String(l.description ?? "").trim().slice(0, 200), amount, account_code: a.code };
		});
		const sum = lines.reduce((t, l) => t + l.amount, 0n);
		if (sum !== BigInt(bill.amount_cents)) throw bad(`the lines add up to ${formatCents(sum)}, not the ${bill.kind}'s ${formatCents(BigInt(bill.amount_cents))}`);
		// A split made by hand takes the place of one made from the items' categories.
		await writeLines(bill.id, lines, false);
		await q(`UPDATE ${T("bill_items")} SET account_code = NULL, tax_id = NULL, no_tax = false WHERE bill_id = $1 AND (account_code IS NOT NULL OR tax_id IS NOT NULL OR no_tax)`, [bill.id]);
		await q(`UPDATE ${T("bills")} SET tax_id = NULL WHERE id = $1 AND tax_id IS NOT NULL`, [bill.id]);
		// The bill's own account is its biggest part (shown in lists; the lines are what's booked).
		const main = lines.reduce((m, l) => (l.amount > m.amount ? l : m), lines[0]);
		await applyFields(bill.id, { account_code: main.account_code }, req.user.username);
		await q(`UPDATE ${T("transactions")} SET chosen_code = $2 WHERE bill_id = $1 AND status = 'new' AND $3::text IS NULL`, [bill.id, main.account_code, bill.ap_account]);
		ctx.log.info("bill split", { bill: String(bill.id), lines: lines.length, by: req.user.username });
		return { bill: await getBill(bill.id), lines: await linesOf(bill.id) };
	});

	ctx.route("DELETE", "/bills/:id/lines", async (req) => {
		const bill = await getBill(req.params.id);
		await assertSplittable(bill);
		await writeLines(bill.id, [], false);
		await q(`UPDATE ${T("bill_items")} SET account_code = NULL, tax_id = NULL, no_tax = false WHERE bill_id = $1 AND (account_code IS NOT NULL OR tax_id IS NOT NULL OR no_tax)`, [bill.id]);
		await q(`UPDATE ${T("bills")} SET tax_id = NULL WHERE id = $1 AND tax_id IS NOT NULL`, [bill.id]);
	});

	/** A statement's balance as another module described it in the file's meta, or null. */
	function moduleBillInfo(meta) {
		if (!meta || typeof meta !== "object") return null;
		const text = (v) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
		const money = (v) => {
			const a = parseAmount(text(v));
			return a !== null && a > 0n ? a : null;
		};
		return billInfoOf(
			{
				vendor: text(meta.vendor),
				bill_date: text(meta.statement_date),
				due_date: text(meta.due_date),
				amount_cents: money(meta.amount_due),
				minimum_cents: money(meta.minimum_payment),
				invoice_number: text(meta.reference),
				currency: text(meta.currency),
			},
			"module",
		);
	}

	/**
	 * What a statement says is owed, as a bill draft (nothing is saved; the user edits it and creates
	 * the bill with POST /bills { ..., statement_id }). What was already read about the statement
	 * (statements.bill_info) is used without the LLM; otherwise, or with reread, the LLM reads the
	 * statement and what it read is kept for next time.
	 */
	async function statementBillDraft(statement, { reread = false } = {}) {
		const { rows: kept } = await q(`SELECT bill_info FROM ${T("statements")} WHERE id = $1`, [statement.id]);
		const { rows: last } = await q(`SELECT max(tx_date)::text AS last FROM ${T("transactions")} WHERE statement_id = $1`, [statement.id]);
		const account = (await accountsByCode()).get(statement.account_code) ?? null;
		if (!reread) {
			// Read once: what Ledger keeps with the statement's document (its extracted data: the parser's
			// balance, what a person confirmed, what another module read), then what this module kept itself.
			const x = await h.files.extractedOf(await h.files.statementDocumentId(statement.id));
			const saved = draftFromBillInfo(billInfoFromData(x?.data), { account, last: last[0]?.last ?? null }) ?? draftFromBillInfo(kept[0]?.bill_info, { account, last: last[0]?.last ?? null });
			if (saved) return saved;
		}
		const draft = await readStatementDraft(statement, account);
		const info = billInfoOf({ ...draft, confidence: draft.confidence }, "llm");
		if (info && draft.amount_cents !== null) {
			// Keep the OFX balance too, should the LLM's reading be taken off later.
			const prev = kept[0]?.bill_info;
			if (prev?.balance_cents != null) Object.assign(info, { balance_cents: prev.balance_cents, balance_date: prev.balance_date ?? null });
			await q(`UPDATE ${T("statements")} SET bill_info = $2 WHERE id = $1`, [statement.id, JSON.stringify(info)]);
		}
		return draft;
	}

	/** The LLM reads what a statement says is owed. */
	async function readStatementDraft(statement, account) {
		const ai = await h.ai();
		const f = await h.files.readStatementFile(statement.id);
		const d = f ? { document: f.data, document_type: f.type } : {};
		const doc = {};
		if (d.document && d.document_type === "application/pdf") {
			if (!ai.readsPdf) throw bad("Ledger's LLM connection for images and documents can't read PDFs (Settings → LLM API); enter the bill by hand");
			doc.pdf = d.document;
		} else if (d.document) doc.text = d.document.toString("utf8");
		const { rows: sums } = await q(
			`SELECT count(*)::int AS n, min(tx_date)::text AS first, max(tx_date)::text AS last,
			        COALESCE(sum(amount_cents) FILTER (WHERE amount_cents < 0), 0) AS out_cents, COALESCE(sum(amount_cents) FILTER (WHERE amount_cents > 0), 0) AS in_cents
			   FROM ${T("transactions")} WHERE statement_id = $1`,
			[statement.id],
		);
		const about = [
			`Statement file: ${statement.filename}${statement.mail_subject ? ` (${statement.mail_subject})` : ""}`,
			`Account: ${account ? `${account.code} ${account.name} (${account.type}, ${account.currency})` : "not chosen yet"}`,
			`${sums[0].n} transactions from ${sums[0].first} to ${sums[0].last}: ${formatCents(BigInt(sums[0].out_cents))} out, ${formatCents(BigInt(sums[0].in_cents))} in.`,
		];
		const r = await readStatementBill({ llm: ai.llm, document: doc, about });
		return {
			kind: "bill",
			vendor: r.vendor || account?.name || "",
			invoice_number: r.invoice_number,
			bill_date: r.bill_date ?? sums[0].last,
			due_date: r.due_date,
			amount_cents: r.amount_cents,
			minimum_cents: r.minimum_cents,
			currency: r.currency || account?.currency || "CAD",
			// Paying a card or loan statement pays down that account.
			account_code: account && account.type === "liability" ? account.code : null,
			confidence: r.confidence,
			summary: r.summary,
			read_from: doc.pdf ? "pdf" : doc.text ? "file" : "summary",
		};
	}

	/** The link from a journal entry to this bill or receipt (Ledger 0.11.2). */
	function billLink(b) {
		const what = b.kind === "receipt" ? "Receipt" : "Bill";
		return {
			ref: `bill:${b.id}`,
			label: `${what} · ${b.vendor || `#${b.id}`}${b.invoice_number ? ` ${b.invoice_number}` : ""}`.slice(0, 200),
			href: `/apps/${ctx.id}?bill=${b.id}`,
		};
	}
	const linkFor = async (id) => billLink(await getBill(String(id)));

	// Tags another module or a person sets on a bill's entry (Ledger 0.23.0): the bill follows. Never posts.
	tags.listen({ unlink, autoMatch, syncBillTodos, complete: (key) => dash.complete(key), reopened: (billId) => h.dtags.clearPaid(billId) });
	// The same for tags on a bill's document (Ledger 0.27.0): "paid" set or taken off on the Documents page or by another module.
	h.dtags.listen({ unlink, autoMatch, syncBillTodos, complete: (key) => dash.complete(key), entryPaid: async (b) => tags.paidByTag(await getBill(String(b.id)).catch(() => b)), entryUnpaid: async (b) => tags.unpaid(await getBill(String(b.id)).catch(() => b)) });

	return { autoMatch, onPosted, paymentAccount, paidOf, vendorOf, ingestDocument, ingestStatementFile, linkFor, getBill, matchBillTx, linkBillEntry, linesOf, statementBillDraft, syncBillTodos, saveBillExtraction, standinOn, standinMode, standinMatches, linkStandin, unlinkStandin, settle };
}

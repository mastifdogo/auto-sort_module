// Ledger's tags on journal entries (ctx.tags, Ledger 0.23.0), shared by Ledger and every module.
//
// - A bill's entry (the payable entry made on approval, else the entry its payment or receipt is
//   recorded in) carries "vendor", "paid" and "overdue", kept true as the bill changes.
// - A tag belongs to the entry: another module or a person can set "paid" on a bill's entry (the
//   bill is then paid here too, and nothing is posted) or take it off (unpaid again).
// - Entries other modules tagged "billed", "overdue" or with a vendor, and not "paid", are what a
//   statement deposit or payment may pay: the row is offered that entry, and when a person posts
//   it, the entry is tagged "paid". Nothing here is decided by the AI.
// - A bill's line items marked billable (by a person) are rate items on that entry (description,
//   quantity, unit, rate; Ledger 0.25.0), so an invoice form can fill itself in from them.
//
// - Customers' and vendors' own accounts (Ledger 0.31.0): an entry with a line in a vendor's own
//   account under accounts payable (a customer's under receivable) needs no "vendor" tag, the
//   account says whose it is, and Ledger reads the tag from it (id 0, account_code set, nothing
//   stored). Setting "vendor" on an entry with a line in the tagged payable account moves that line
//   into the vendor's account; removing a tag read from the account moves the line back. So the
//   tag is set only where no line says it yet, and such a tag is taken off only when the bill's
//   vendor was changed, on this module's own entries, never as tidying up.
//
// - Linked payments (Ledger 0.33.0, ctx.ledger.linkPayment): the entry that pays a bill's entry is
//   linked to it as its payment, with the share that goes to this bill. Neither entry changes.
//   Ledger shows the payments on the entry and itself keeps exactly one of "unpaid",
//   "partially_paid" and "paid" on it as payments are linked, taken off or reversed. So for a bill
//   with an entry of its own whose payments are linked (bills.payments_linked_at), the tag on the
//   entry says whether the bill is paid, and the bill follows it: this module sets one of the
//   three only where none is there ("unpaid" on a new bill's entry, the one the linked payments
//   say after someone took it off) and on a person's own Mark paid or Reopen. It never works out
//   "paid" from payments there.
//
// On a Ledger without ctx.tags every function here does nothing; without ctx.ledger.linkPayment
// payments and the "paid" tag are kept as before 0.30.0.

import { shareToken } from "./bills.mjs";
import { isPayable, isReceivable, sameControl } from "./payables.mjs";

const DAY = 86_400_000;
const days = (iso) => Date.parse(String(iso).slice(0, 10) + "T00:00:00Z") / DAY;
const hasTag = (e, tag) => (e.tags ?? []).some((t) => t.tag === tag);

/**
 * Entries a statement row could pay (pure): tagged as owed and not paid, not reversed, not this
 * module's own, with a line of exactly the row's amount on the other side: a deposit pays an entry
 * tagged "billed" or "overdue" that debits a receivable (asset) account; a payment pays one tagged
 * with a vendor or "overdue" that credits a payable (liability) account. row: { account_code,
 * date, description, amount_cents }; accounts: Map code -> account. Best first: the customer's or
 * vendor's name in the row's description, then overdue ones, then the oldest. account_code is the
 * account the entry's line really sits in (the customer's or vendor's own account since Ledger
 * 0.31.0), which is where the row is booked. An entry tagged "partially_paid" is only paid by a
 * row for exactly what is left of it (entry.left_cents, from Ledger's linked payments).
 */
export function payableCandidates(row, entries, accounts, moduleId) {
	const amt = BigInt(row.amount_cents);
	if (amt === 0n) return [];
	const abs = amt < 0n ? -amt : amt;
	const deposit = amt > 0n;
	const currency = accounts.get(row.account_code)?.currency;
	const out = [];
	for (const e of entries) {
		if (e.reverses_id != null || e.reversed_by_id != null || hasTag(e, "paid")) continue;
		// Partially paid (Ledger 0.33.0): only a row for exactly what is left of it pays it.
		const left = e.left_cents === null || e.left_cents === undefined ? null : BigInt(e.left_cents);
		if (left === null ? hasTag(e, "partially_paid") : left !== abs) continue;
		const fits = (v) => (left === null ? BigInt(v) === abs : BigInt(v) >= abs);
		if ((e.links ?? []).some((l) => l.module_id === moduleId)) continue;
		if (!(deposit ? hasTag(e, "billed") || hasTag(e, "overdue") : hasTag(e, "vendor") || hasTag(e, "overdue"))) continue;
		const ago = days(row.date) - days(e.entry_date);
		if (ago < -10 || ago > 400) continue;
		const lines = e.lines.filter((l) => {
			const a = accounts.get(l.account_code);
			if (!a || a.is_active === false || a.hidden || l.account_code === row.account_code || (currency && a.currency !== currency)) return false;
			return deposit ? a.type === "asset" && fits(l.debit_cents) : a.type === "liability" && fits(l.credit_cents);
		});
		// The receivable or payable line when several fit: the customer's or vendor's own account, or the tagged one.
		const line = lines.find((l) => (deposit ? isReceivable : isPayable)(accounts.get(l.account_code))) ?? lines[0];
		if (!line) continue;
		const role = deposit ? "customer" : "vendor";
		const owner = accounts.get(line.account_code)?.entity;
		const who = [...(owner?.role === role ? [{ id: owner.id, name: owner.name }] : []), ...(e.tags ?? []).filter((t) => t.tag === role && t.entity).map((t) => t.entity), ...(e.entity ? [e.entity] : [])];
		const named = who.some((w) => shareToken(w.name, row.description));
		const overdue = hasTag(e, "overdue");
		out.push({
			entry_id: e.id,
			account_code: line.account_code,
			date: String(e.entry_date).slice(0, 10),
			description: e.description,
			reference: e.reference ?? "",
			role,
			who: who[0] ?? null,
			named,
			overdue,
			score: Math.min(0.6 + (named ? 0.3 : 0) + (overdue ? 0.05 : 0), 0.95),
		});
	}
	return out.sort((a, b) => b.score - a.score || days(a.date) - days(b.date));
}

/**
 * One entry per row and one row per entry, best first (pure). A pair without the customer's or
 * vendor's name in the description is only offered when nothing else has that amount: the row has
 * no other candidate and the entry no other row. allow(row, candidate) can veto a pair.
 */
export function assignPayables(rows, entries, accounts, moduleId, allow = () => true) {
	const pairs = [];
	const perEntry = new Map();
	for (const row of rows) {
		const cands = payableCandidates(row, entries, accounts, moduleId).filter((c) => allow(row, c));
		for (const c of cands) {
			pairs.push({ row, candidate: c, alone: cands.length === 1 });
			perEntry.set(String(c.entry_id), (perEntry.get(String(c.entry_id)) ?? 0) + 1);
		}
	}
	pairs.sort((a, b) => b.candidate.score - a.candidate.score);
	const usedRows = new Set();
	const usedEntries = new Set();
	const out = [];
	for (const p of pairs) {
		const r = String(p.row.id);
		const e = String(p.candidate.entry_id);
		if (usedRows.has(r) || usedEntries.has(e)) continue;
		if (!p.candidate.named && !(p.alone && perEntry.get(e) === 1)) continue;
		usedRows.add(r);
		usedEntries.add(e);
		out.push(p);
	}
	return out;
}

export function entryTags(ctx, { q, T }) {
	const on = !!ctx.tags && typeof ctx.tags.set === "function";
	/** Ledger 0.31.0: customers and vendors have accounts of their own, and "customer"/"vendor" are read from them. */
	const ownAccounts = typeof ctx.entities?.account === "function";
	/** Whether the entry's line in a customer's or vendor's own account already says who it is with. */
	const saidByAccount = (tags, role) => (tags ?? []).some((t) => t.tag === role && t.account_code);
	const today = () => new Date().toISOString().slice(0, 10);
	const warn = (what, entryId, tag, err) => ctx.log.warn(what, { entry: String(entryId), tag, err: String(err?.message || err) });
	/** Ledger 0.33.0: payments are linked to the entry they pay, and Ledger keeps unpaid / partially_paid / paid on it. */
	const paymentsOn = on && ["linkPayment", "unlinkPayment", "payments"].every((f) => typeof ctx.ledger?.[f] === "function");
	const STATUS_TAGS = ["paid", "partially_paid", "unpaid"];
	/** The one of the three status tags an entry carries ("paid" first), or null. */
	const statusTag = (tags) => STATUS_TAGS.find((s) => (tags ?? []).some((t) => t.tag === s)) ?? null;

	/** Tags an entry; never fails the work that led to it. */
	async function set(entryId, tag, opts = {}, user) {
		if (!on || entryId === null || entryId === undefined) return false;
		try {
			await ctx.tags.set(entryId, tag, opts, user);
			return true;
		} catch (err) {
			warn("entry not tagged", entryId, tag, err);
			return false;
		}
	}
	async function remove(entryId, tag, opts = {}) {
		if (!on || entryId === null || entryId === undefined) return false;
		try {
			await ctx.tags.remove(entryId, tag, opts);
			return true;
		} catch (err) {
			warn("entry tag not removed", entryId, tag, err);
			return false;
		}
	}
	/** The entry's tags, or null when it can't be read (gone in root mode, or no tags in this Ledger). */
	async function of(entryId) {
		if (!on || entryId === null || entryId === undefined) return null;
		try {
			return await ctx.tags.of(entryId);
		} catch {
			return null;
		}
	}

	// -----------------------------------------------------------------------
	// Linked payments (Ledger 0.33.0)
	// -----------------------------------------------------------------------

	const big = (v) => BigInt(String(v ?? 0));
	/** Ledger's answer with its amounts as bigints, or null. */
	const shaped = (p) =>
		p
			? {
					currency: p.currency,
					due_cents: big(p.due_cents),
					paid_cents: big(p.paid_cents),
					left_cents: big(p.left_cents),
					status: STATUS_TAGS.includes(p.status) ? p.status : "unpaid",
					payments: (p.payments ?? []).map((x) => ({ entry_id: Number(x.entry_id), entry_date: String(x.entry_date ?? "").slice(0, 10), description: x.description ?? "", amount_cents: big(x.amount_cents), counted: x.counted !== false, note: x.note ?? "" })),
				}
			: null;

	/**
	 * Says in Ledger that entry `paymentId` pays entry `entryId`, `amount` cents of it going to this
	 * entry (null: all of the payment). Neither entry changes; Ledger then keeps the entry's unpaid /
	 * partially_paid / paid tag. Returns what is paid and left now ({ due_cents, paid_cents,
	 * left_cents, status, payments }), or null when nothing was linked: an older Ledger, or Ledger
	 * refused (logged; with strict it throws 409 instead). The same pair again changes the amount.
	 */
	async function linkPayment(entryId, paymentId, amount, note, user, { strict = false } = {}) {
		if (!paymentsOn || entryId === null || entryId === undefined || paymentId === null || paymentId === undefined || String(entryId) === String(paymentId)) return null;
		try {
			const share = amount === null || amount === undefined ? null : big(amount);
			return shaped(await ctx.ledger.linkPayment(entryId, paymentId, { ...(share !== null && share > 0n ? { amount_cents: share } : {}), note: String(note ?? "").slice(0, 200) }, user));
		} catch (err) {
			if (strict) throw new ctx.HttpError(409, `Ledger could not link entry #${paymentId} as a payment of entry #${entryId}: ${String(err?.message || err)}`);
			ctx.log.warn("payment not linked to the entry it pays", { entry: String(entryId), payment: String(paymentId), err: String(err?.message || err) });
			return null;
		}
	}
	/** Takes a payment off the entry it was linked to (un-posted, unlinked, the match undone). Never fails; false when there was no link. */
	async function unlinkPayment(entryId, paymentId, user) {
		if (!paymentsOn || entryId === null || entryId === undefined || paymentId === null || paymentId === undefined) return false;
		try {
			return (await ctx.ledger.unlinkPayment(entryId, paymentId, user)) === true;
		} catch (err) {
			ctx.log.warn("payment not unlinked from the entry it paid", { entry: String(entryId), payment: String(paymentId), err: String(err?.message || err) });
			return false;
		}
	}
	/** The payments linked to an entry in Ledger and what they leave: null when none is linked, false when it can't be read. */
	async function payments(entryId) {
		if (!paymentsOn || entryId === null || entryId === undefined) return null;
		try {
			return shaped(await ctx.ledger.payments(entryId));
		} catch {
			return false;
		}
	}
	/**
	 * Whether Ledger's linked payments say what is paid of this bill: it has an entry of its own and
	 * the payments posted for it before were linked to it (at approval, or by the backfill).
	 */
	const managed = (b) => paymentsOn && b?.journal_entry_id !== null && b?.journal_entry_id !== undefined && !!b.payments_linked_at;
	/** The payment that completed it: the newest one Ledger counts. */
	const lastCounted = (p) => p?.payments.filter((x) => x.counted).at(-1)?.entry_id ?? null;

	// -----------------------------------------------------------------------
	// Bills: the tags on a bill's entry follow the bill
	// -----------------------------------------------------------------------

	/** The entry other modules would look at for this bill: the payable entry, else the one it's recorded in. */
	const billEntry = (b) => b.journal_entry_id ?? b.paid_entry_id ?? null;
	const BILL = `id, kind, status, vendor, invoice_number, due_date::text AS due_date, amount_cents, journal_entry_id, ap_account, paid_entry_id, vendor_entity_id, tags_synced_at, payments_linked_at`;

	/** Someone else tagged the bill's entry "paid": the bill is paid here too. Nothing is posted. */
	async function paidElsewhere(billId, by) {
		const { rowCount } = await q(
			`UPDATE ${T("bills")} SET status = 'paid', paid_at = now(), paid_by_tag = true, paid_tag_by = $2, updated_at = now() WHERE id = $1 AND status IN ('new', 'open')`,
			[billId, String(by || "a person").slice(0, 100)],
		);
		return rowCount > 0;
	}
	const whoSet = (t) => (t?.module_id ? `module ${t.module_id}` : t?.set_by || "a person");
	/** The payments linked to the bill's entry cover it (Ledger tagged it "paid"): the bill is paid. */
	async function paidByPayments(billId, entryId) {
		const { rowCount } = await q(
			`UPDATE ${T("bills")} SET status = 'paid', paid_entry_id = $2, paid_at = now(), paid_by_tag = false, paid_tag_by = NULL, updated_at = now() WHERE id = $1 AND status IN ('new', 'open')`,
			[billId, entryId === null || entryId === undefined ? null : String(entryId)],
		);
		return rowCount > 0;
	}
	/** The bill's entry isn't "paid" any more (a payment was reversed or taken off, or the tag was): the bill is open again. */
	async function unpaidAgain(billId) {
		const { rowCount } = await q(`UPDATE ${T("bills")} SET status = 'open', paid_at = NULL, paid_entry_id = NULL, paid_by_tag = false, paid_tag_by = NULL, updated_at = now() WHERE id = $1 AND status = 'paid'`, [billId]);
		return rowCount > 0;
	}

	/**
	 * A bill whose payments are linked through Ledger: the status tag on its entry decides. With no
	 * status tag there, the one its linked payments say is set: "unpaid" without any, or "paid" for a
	 * bill that is paid here without a payment (Mark paid), unless that tag was just taken off by
	 * someone (removed: then the bill is unpaid again). Returns { status: the bill's status now,
	 * became: "paid" | "open" | null, p: Ledger's payments }, or null when those can't be read
	 * (nothing is changed then).
	 */
	async function followEntry(b, tags, user, { removed = false } = {}) {
		const entry = b.journal_entry_id;
		const p = await payments(entry);
		if (p === false) return null;
		let st = statusTag(tags);
		if (st === null) {
			st = !removed && b.status === "paid" && !p ? "paid" : (p?.status ?? "unpaid");
			await set(entry, st, {}, user);
		}
		if (st === "paid" && ["new", "open"].includes(b.status)) {
			const tag = tags.find((t) => t.tag === "paid");
			const ok = p?.status === "paid" ? await paidByPayments(b.id, lastCounted(p)) : await paidElsewhere(b.id, whoSet(tag));
			return { status: ok ? "paid" : b.status, became: ok ? "paid" : null, p };
		}
		if (st !== "paid" && b.status === "paid") {
			const ok = await unpaidAgain(b.id);
			return { status: ok ? "open" : b.status, became: ok ? "open" : null, p };
		}
		return { status: b.status, became: null, p };
	}

	/**
	 * Brings the tags on a bill's entry in line with the bill: its vendor, "paid" while it is paid,
	 * "overdue" while it's an approved bill past its due date. A "paid" someone else put on the entry
	 * of an unpaid bill makes the bill paid instead. On Ledger 0.33.0, for a bill with an entry of
	 * its own whose payments are linked there (managed()), it is the other way round: Ledger keeps
	 * "unpaid", "partially_paid" or "paid" on the entry and the bill follows that tag; only a missing
	 * one is set ("unpaid" for a new bill). b: a bills row (BILL columns, or getBill's). Returns
	 * "paid" when the bill became paid that way, "open" when it stopped being paid.
	 */
	async function syncBill(b, user) {
		// The billable line items go on the same entry as rate items (or come off an entry it left).
		await syncItems(b, user).catch((err) => ctx.log.warn("bill items not put on its entry", { bill: String(b.id), err: String(err?.message || err) }));
		const entry = billEntry(b);
		if (!on || entry === null) return null;
		const tags = await of(entry);
		if (!tags) return null;
		const has = (tag) => tags.find((t) => t.tag === tag);
		let status = b.status;
		let became = null;
		const paid = has("paid");
		// Its payments are linked through Ledger (0.33.0): the status tag on the entry decides, and
		// Ledger keeps it. Otherwise "paid" follows the bill, as before.
		const byLedger = managed(b);
		const kept = byLedger ? await followEntry(b, tags, user) : null;
		if (kept) ({ status, became } = kept);
		else if (!byLedger && paid && paid.module_id !== ctx.id && ["new", "open"].includes(status) && (await paidElsewhere(b.id, whoSet(paid)))) {
			status = "paid";
			became = "paid";
		}
		const vendor = b.vendor_entity_id === null || b.vendor_entity_id === undefined ? null : Number(b.vendor_entity_id);
		// A line in a vendor's own account says whose the entry is (Ledger 0.31.0): no tag then. Else the
		// tag is set; where the entry has a line in accounts payable, Ledger moves it into the vendor's account.
		if (vendor && !saidByAccount(tags, "vendor") && !tags.some((t) => t.tag === "vendor" && Number(t.entity?.id) === vendor)) await set(entry, "vendor", { entity_id: vendor }, user);
		if (!byLedger) {
			if (status === "paid") {
				// Its payment is another entry when the bill went through payables: the note says which.
				const note = b.journal_entry_id && b.paid_entry_id ? `payment in entry #${b.paid_entry_id}` : "";
				if (!paid) await set(entry, "paid", note ? { note } : {}, user);
			} else if (paid) await remove(entry, "paid");
		}
		if (status !== "paid") {
			const overdue = b.kind === "bill" && status === "open" && !!b.due_date && String(b.due_date).slice(0, 10) < today();
			if (overdue && !has("overdue")) await set(entry, "overdue", {}, user);
			if (!overdue && has("overdue")) await remove(entry, "overdue");
		}
		if (!b.tags_synced_at) await q(`UPDATE ${T("bills")} SET tags_synced_at = now() WHERE id = $1 AND tags_synced_at IS NULL`, [b.id]);
		return became;
	}

	// -----------------------------------------------------------------------
	// Line items: each billable item of a bill is a rate item on its entry (Ledger 0.25.0)
	// -----------------------------------------------------------------------

	const ratesOn = on && ["addRate", "setRate", "rates", "removeRate"].every((f) => typeof ctx.tags[f] === "function");
	const ITEM = `id, description, quantity::text AS quantity, unit, rate_cents, billable, rate_entry_id, rate_tag_id`;

	/** What Ledger's rate item for a line item says (description, quantity, unit, rate_cents). */
	const rateOf = (it) => ({
		description: it.description || null,
		quantity: it.quantity === null || it.quantity === undefined ? null : Number(it.quantity),
		unit: it.unit || null,
		rate_cents: it.rate_cents === null || it.rate_cents === undefined ? null : Number(it.rate_cents),
	});
	const sameRate = (a, b) => (a.description ?? null) === (b.description ?? null) && (a.quantity ?? null) === (b.quantity ?? null) && (a.unit ?? null) === (b.unit ?? null) && (a.rate_cents ?? null) === (b.rate_cents ?? null);

	/** Takes one rate item this module put on an entry off it; never fails. */
	async function dropRate(entryId, tagId) {
		if (!ratesOn || entryId === null || entryId === undefined || tagId === null || tagId === undefined) return;
		try {
			await ctx.tags.removeRate(entryId, Number(tagId));
		} catch (err) {
			warn("rate item not removed", entryId, "rate", err);
		}
	}

	/**
	 * Puts the bill's billable line items on its entry as rate items, keeps them in line with the
	 * items, and takes off those no longer billable, deleted, or on an entry the bill left (approval
	 * undone, ignored). A rate item someone took off the entry makes its line item not billable
	 * (the person decided). b: { id, status, journal_entry_id, paid_entry_id }. Returns how many
	 * rate items were added or changed.
	 */
	async function syncItems(b, user) {
		if (!ratesOn) return 0;
		const { rows: items } = await q(`SELECT ${ITEM} FROM ${T("bill_items")} WHERE bill_id = $1 AND (billable OR rate_tag_id IS NOT NULL) ORDER BY line_no`, [b.id]);
		if (items.length === 0) return 0;
		const entry = b.status === "ignored" ? null : billEntry(b);
		const clear = (id) => q(`UPDATE ${T("bill_items")} SET rate_entry_id = NULL, rate_tag_id = NULL WHERE id = $1`, [id]);
		let rates;
		const ratesNow = async () => {
			if (rates === undefined) {
				try {
					rates = await ctx.tags.rates(entry);
				} catch {
					rates = null; // gone in root mode: nothing to do until it's back
				}
			}
			return rates;
		};
		let n = 0;
		for (const it of items) {
			if (it.rate_tag_id !== null && (!it.billable || entry === null || String(it.rate_entry_id) !== String(entry))) {
				await dropRate(it.rate_entry_id, it.rate_tag_id);
				await clear(it.id);
				it.rate_tag_id = null;
			}
			if (!it.billable || entry === null) continue;
			const list = await ratesNow();
			if (!list) break;
			const want = rateOf(it);
			try {
				if (it.rate_tag_id !== null) {
					const have = list.find((r) => Number(r.id) === Number(it.rate_tag_id));
					if (!have) {
						// Someone took it off the entry: it's no longer billable.
						await q(`UPDATE ${T("bill_items")} SET billable = false, rate_entry_id = NULL, rate_tag_id = NULL WHERE id = $1`, [it.id]);
						continue;
					}
					if (!sameRate(want, have)) {
						await ctx.tags.setRate(entry, { id: Number(it.rate_tag_id), ...want }, user);
						n++;
					}
				} else {
					const added = await ctx.tags.addRate(entry, want, user);
					if (added?.id) await q(`UPDATE ${T("bill_items")} SET rate_entry_id = $2, rate_tag_id = $3 WHERE id = $1`, [it.id, String(entry), String(added.id)]);
					n++;
				}
			} catch (err) {
				warn("rate item not set", entry, "rate", err);
			}
		}
		return n;
	}

	/**
	 * Someone else changed or removed rate items on an entry: line items follow. A removed one is no
	 * longer billable; a changed one takes the entry's description, quantity, unit and rate.
	 */
	async function itemsFollow(entryId) {
		const { rows: items } = await q(`SELECT ${ITEM} FROM ${T("bill_items")} WHERE rate_entry_id = $1 AND rate_tag_id IS NOT NULL`, [String(entryId)]);
		if (items.length === 0) return;
		let list;
		try {
			list = await ctx.tags.rates(entryId);
		} catch {
			return;
		}
		for (const it of items) {
			const have = list.find((r) => Number(r.id) === Number(it.rate_tag_id));
			if (!have) {
				await q(`UPDATE ${T("bill_items")} SET billable = false, rate_entry_id = NULL, rate_tag_id = NULL WHERE id = $1`, [it.id]);
				ctx.log.info("bill item no longer billable: its rate item was taken off the entry", { item: String(it.id), entry: String(entryId) });
			} else if (!sameRate(rateOf(it), have)) {
				await q(`UPDATE ${T("bill_items")} SET description = COALESCE($2, description), quantity = $3, unit = COALESCE($4, ''), rate_cents = $5, amount_cents = COALESCE($6, amount_cents) WHERE id = $1`, [
					it.id,
					have.description ?? null,
					have.quantity ?? null,
					have.unit ?? null,
					have.rate_cents ?? null,
					have.amount_cents ?? null,
				]);
			}
		}
	}

	/** The entry no longer stands for an open or paid bill (its approval was undone): the status tags go. */
	async function clearStatus(entryId) {
		await remove(entryId, "paid");
		await remove(entryId, "overdue");
		if (paymentsOn) for (const tag of ["partially_paid", "unpaid"]) await remove(entryId, tag);
	}

	/**
	 * The bill became paid without a payment entry to link (its document was tagged "paid" by
	 * someone): where Ledger keeps the entry's status tag, "paid" is set here, since the sync only
	 * follows the tag there; elsewhere the sync sets it.
	 */
	async function paidByTag(b, user) {
		if (managed(b)) await set(b.journal_entry_id, "paid", {}, user);
	}

	/**
	 * A person reopened a paid bill here (or took "paid" off its document): its entry isn't "paid".
	 * Where Ledger keeps the status tag, the one its linked payments say is set ("unpaid" without
	 * any), which takes "paid" off; else "paid" is removed.
	 */
	async function unpaid(b, user) {
		const entry = billEntry(b);
		if (entry === null) return;
		const p = managed(b) ? await payments(entry) : false;
		if (p === false) return void (await remove(entry, "paid"));
		await set(entry, p && p.status !== "paid" ? p.status : "unpaid", {}, user);
	}

	/**
	 * A bill linked by hand to an entry is unlinked: what this module tagged on that entry goes. A
	 * "vendor" read from the vendor's own account stays: taking it off would move the entry's line
	 * back to accounts payable, and the entry is still that vendor's.
	 */
	async function clearLinked(entryId, vendorEntityId) {
		const tags = await of(entryId);
		if (!tags) return;
		await remove(entryId, "paid");
		const v = vendorEntityId === null || vendorEntityId === undefined ? null : Number(vendorEntityId);
		if (v && tags.some((t) => t.tag === "vendor" && Number(t.entity?.id) === v && t.module_id === ctx.id && !t.account_code)) await remove(entryId, "vendor", { entity_id: v });
	}

	/**
	 * A person changed the bill's vendor (before → after, both bills rows). The entries that said
	 * the previous one follow: the bill's entry and, of its posted payments (paymentEntries: their
	 * entry ids), the ones this module tagged or posted to the previous vendor's own account. Where
	 * the tag is read from that account (Ledger 0.31.0), taking it off moves the line back to
	 * accounts payable, and the new vendor's tag moves it on into the new vendor's account, so each
	 * vendor's balance is right again. That is only done to this module's own entries (the payable
	 * entry and the payments it posted), never to an entry a bill was linked to by hand. The bill's
	 * own entry gets its new vendor from syncBill(), which the caller runs next.
	 */
	async function vendorChanged(before, after, paymentEntries = [], user) {
		const old = before.vendor_entity_id === null || before.vendor_entity_id === undefined ? null : Number(before.vendor_entity_id);
		const now = after.vendor_entity_id === null || after.vendor_entity_id === undefined ? null : Number(after.vendor_entity_id);
		if (!on || !old || old === now) return;
		const main = billEntry(after) === null ? null : String(billEntry(after));
		const mine = new Set([after.journal_entry_id, ...paymentEntries].filter((x) => x !== null && x !== undefined).map(String));
		for (const id of new Set([...(main ? [main] : []), ...mine])) {
			const t = (await of(id))?.find((x) => x.tag === "vendor" && Number(x.entity?.id) === old);
			if (!t) continue;
			if (t.account_code ? !mine.has(id) : id !== main && t.module_id !== ctx.id) continue;
			await remove(id, "vendor", { entity_id: old });
			if (now && id !== main) await tagWho({ id }, "vendor", now, user);
		}
	}

	/** Once, at startup: bills approved before this version get their tags (bills.tags_synced_at remembers). */
	async function backfill() {
		if (!on) return 0;
		const { rows } = await q(`SELECT ${BILL} FROM ${T("bills")} WHERE tags_synced_at IS NULL AND COALESCE(journal_entry_id, paid_entry_id) IS NOT NULL ORDER BY id`);
		for (const b of rows) await syncBill(b);
		return rows.length;
	}

	const paymentNote = (b) => `payment of ${b.kind === "receipt" ? "receipt" : "bill"} ${b.vendor || `#${b.id}`}${b.invoice_number ? ` ${b.invoice_number}` : ""} (${ctx.name})`.slice(0, 200);

	/**
	 * Links the payments already posted for a bill to its entry in Ledger (0.33.0), each with the
	 * share that pays this bill, and from then on lets Ledger say what is paid of it
	 * (bills.payments_linked_at). The payments: the statement rows posted as its payment (their
	 * entries debit payables), and the entry it was linked to by hand, for what the rows don't
	 * cover. Safe to run again (the same pair again only sets the amount); it posts, reverses and
	 * moves nothing. b: a bills row (BILL columns, or getBill's). Returns how many were linked.
	 */
	async function linkBillPayments(b, user) {
		if (!paymentsOn || b.journal_entry_id === null || b.journal_entry_id === undefined) return 0;
		const { rows } = await q(
			`SELECT id, journal_entry_id, (-amount_cents - COALESCE(split_cents, 0)) AS share_cents FROM ${T("transactions")}
			  WHERE bill_id = $1 AND status = 'posted' AND journal_entry_id IS NOT NULL ORDER BY id`,
			[b.id],
		);
		const accounts = rows.length > 0 ? await accountsByCode() : new Map();
		const seen = new Set([String(b.journal_entry_id)]);
		let n = 0;
		let covered = 0n;
		for (const t of rows) {
			const share = big(t.share_cents);
			if (seen.has(String(t.journal_entry_id)) || share <= 0n) continue;
			const e = await ctx.ledger.getJournalEntry(Number(t.journal_entry_id)).catch(() => null);
			// Only a row booked as the bill's payment: its entry debits payables (the vendor's own account,
			// or the account the bill went through). A row given another account paid something else.
			if (!e || e.reverses_id != null || !(e.lines ?? []).some((l) => big(l.debit_cents) > 0n && (l.account_code === b.ap_account || isPayable(accounts.get(l.account_code))))) continue;
			seen.add(String(t.journal_entry_id));
			if (!(await linkPayment(b.journal_entry_id, t.journal_entry_id, share, paymentNote(b), user))) continue;
			n++;
			if (e.reversed_by_id == null) covered += share;
		}
		// Linked by hand to an entry that records its payment: that entry pays what the rows don't.
		if (b.status === "paid" && b.paid_entry_id !== null && b.paid_entry_id !== undefined && !seen.has(String(b.paid_entry_id))) {
			const rest = b.amount_cents === null || b.amount_cents === undefined ? null : big(b.amount_cents) - covered;
			if ((rest === null || rest > 0n) && (await linkPayment(b.journal_entry_id, b.paid_entry_id, rest, `${paymentNote(b)}, linked by hand`, user))) n++;
		}
		await q(`UPDATE ${T("bills")} SET payments_linked_at = now() WHERE id = $1`, [b.id]);
		return n;
	}

	/**
	 * At startup, on Ledger 0.33.0 or newer: bills whose payments were recorded before 0.30.0 (or on
	 * an older Ledger) get them linked to their entries, once each (bills.payments_linked_at), and
	 * their status then follows Ledger's tag. The rows that paid another module's entry are linked
	 * to it too, once per organization (module_state). Nothing is posted, reversed or moved.
	 * Returns { bills, payments }.
	 */
	async function backfillPayments() {
		if (!paymentsOn) return { bills: 0, payments: 0 };
		const { rows } = await q(`SELECT ${BILL} FROM ${T("bills")} WHERE journal_entry_id IS NOT NULL AND payments_linked_at IS NULL ORDER BY id`);
		let n = 0;
		for (const b of rows) {
			try {
				n += await linkBillPayments(b);
				await syncBill({ ...b, payments_linked_at: new Date() });
			} catch (err) {
				ctx.log.warn("a bill's payments were not linked in Ledger", { bill: String(b.id), err: String(err?.message || err) });
			}
		}
		const { rows: done } = await q(`SELECT 1 FROM ${T("module_state")} WHERE key = 'payment_links'`);
		if (done.length === 0) {
			const { rows: paid } = await q(
				`SELECT DISTINCT pays_entry_id, journal_entry_id, abs(amount_cents) AS amount_cents FROM ${T("transactions")}
				  WHERE status = 'posted' AND pays_entry_id IS NOT NULL AND journal_entry_id IS NOT NULL AND bill_id IS NULL ORDER BY journal_entry_id`,
			);
			let m = 0;
			for (const r of paid) if (await linkPayment(r.pays_entry_id, r.journal_entry_id, r.amount_cents, `paid by a statement row (${ctx.name})`)) m++;
			n += m;
			await q(`INSERT INTO ${T("module_state")} (key, value) VALUES ('payment_links', $1::jsonb) ON CONFLICT (key) DO NOTHING`, [JSON.stringify({ at: new Date().toISOString(), entries_paid: m })]);
		}
		return { bills: rows.length, payments: n };
	}

	// -----------------------------------------------------------------------
	// Tags set or removed by another module or a person
	// -----------------------------------------------------------------------

	/**
	 * after: { unlink(billId), autoMatch(), syncBillTodos(), complete(key), reopened(billId) } from the bill routes.
	 * Nothing is ever posted in reaction to a tag.
	 */
	function listen(after) {
		if (!on || typeof ctx.tags.onChange !== "function") return;
		ctx.tags.onChange(async (c) => {
			if (!c || c.module_id === ctx.id) return;
			if (c.tag === "rate") return ratesOn ? itemsFollow(c.entry_id) : undefined;
			if (![...STATUS_TAGS, "vendor"].includes(c.tag)) return;
			const { rows } = await q(`SELECT ${BILL} FROM ${T("bills")} WHERE journal_entry_id = $1 OR (journal_entry_id IS NULL AND paid_entry_id = $1) ORDER BY id`, [String(c.entry_id)]);
			for (const b of rows) {
				if (c.tag === "vendor") {
					if (c.action !== "set" || b.vendor_entity_id !== null || !c.entity_id) continue;
					const name = (await of(c.entry_id))?.find((t) => t.tag === "vendor" && t.entity?.id === Number(c.entity_id))?.entity?.name ?? "";
					await q(`UPDATE ${T("bills")} SET vendor_entity_id = $2, vendor = CASE WHEN vendor = '' THEN $3 ELSE vendor END, updated_at = now() WHERE id = $1 AND vendor_entity_id IS NULL`, [b.id, String(c.entity_id), name.slice(0, 200)]);
					ctx.log.info("bill vendor filled from a tag", { bill: String(b.id), entry: String(c.entry_id), entity: String(c.entity_id) });
				} else if (managed(b)) {
					// Ledger keeps unpaid / partially_paid / paid on this entry from its linked payments (one was
					// linked, taken off or reversed), or a person changed the tag: the bill follows the tag as it
					// is now. Nothing is set against it, so nothing loops.
					const r = await followEntry(b, (await of(c.entry_id)) ?? [], undefined, { removed: c.action === "removed" });
					if (r?.became === "paid") {
						// Its payment isn't expected from a statement any more.
						await after.unlink(b.id);
						await after.complete(`bill-${b.id}`);
						await after.syncBillTodos();
						ctx.log.info("bill paid: its entry is tagged paid in Ledger", { bill: String(b.id), entry: String(c.entry_id), by_payments: r.p?.status === "paid" });
					} else if (r?.became === "open") {
						await after.reopened?.(b.id);
						await after.autoMatch();
						ctx.log.info("bill unpaid again: its entry is no longer tagged paid in Ledger", { bill: String(b.id), entry: String(c.entry_id), tag: c.tag, action: c.action });
					}
				} else if (c.tag !== "paid") {
					// "unpaid" and "partially_paid" only mean something here where Ledger keeps them (above).
				} else if (c.action === "set") {
					if (!["new", "open"].includes(b.status)) continue;
					const by = whoSet((await of(c.entry_id))?.find((t) => t.tag === "paid") ?? { module_id: c.module_id });
					if (!(await paidElsewhere(b.id, by))) continue;
					// Its payment isn't expected from a statement any more.
					await after.unlink(b.id);
					await after.complete(`bill-${b.id}`);
					await after.syncBillTodos();
					ctx.log.info("bill paid: its entry was tagged paid", { bill: String(b.id), entry: String(c.entry_id), by });
				} else if (b.status === "paid") {
					const { rows: posted } = await q(`SELECT 1 FROM ${T("transactions")} WHERE bill_id = $1 AND status = 'posted' LIMIT 1`, [b.id]);
					if (b.paid_entry_id !== null || posted.length > 0) {
						// Its payment is in the journal: it is paid whatever the tag says, so the tag goes back.
						await set(c.entry_id, "paid", b.journal_entry_id && b.paid_entry_id ? { note: `payment in entry #${b.paid_entry_id}` } : {});
						ctx.log.info("paid tag put back: the bill's payment is in the journal", { bill: String(b.id), entry: String(c.entry_id) });
						continue;
					}
					await q(`UPDATE ${T("bills")} SET status = 'open', paid_at = NULL, paid_by_tag = false, paid_tag_by = NULL, updated_at = now() WHERE id = $1 AND status = 'paid'`, [b.id]);
					// Its document isn't "paid" any more either (Ledger's tags on files, lib/doc-tags.mjs).
					await after.reopened?.(b.id);
					await after.autoMatch();
					ctx.log.info("bill unpaid again: the paid tag was taken off its entry", { bill: String(b.id), entry: String(c.entry_id) });
				}
			}
		});
	}

	// -----------------------------------------------------------------------
	// Statement rows that pay what another module tagged as owed
	// -----------------------------------------------------------------------

	/** Entries tagged as owed (billed, overdue, or with a vendor), newest first, each once. */
	async function owedEntries() {
		const seen = new Map();
		for (const tag of ["overdue", "billed", "vendor"]) {
			let list = [];
			try {
				list = await ctx.tags.entries({ tag, limit: 500 });
			} catch (err) {
				ctx.log.warn("tagged entries not read", { tag, err: String(err?.message || err) });
			}
			for (const e of list) if (!seen.has(String(e.id))) seen.set(String(e.id), e);
		}
		return Promise.all([...seen.values()].map(withLeft));
	}
	/** A partially paid entry with what is left of it (Ledger's linked payments), for payableCandidates. */
	async function withLeft(e) {
		if (!hasTag(e, "partially_paid")) return e;
		const p = await payments(e.id);
		return p ? { ...e, left_cents: p.left_cents } : e;
	}

	const accountsByCode = async () => new Map((await ctx.ledger.listAccounts({ includeInactive: true })).map((a) => [a.code, a]));

	/**
	 * Offers unposted rows the entry they could pay (no AI): the row gets the entry's receivable or
	 * payable account as its suggestion. Posting it (a person) is what tags the entry "paid". Rows
	 * whose entry has since been paid or reversed lose the offer. Returns how many rows were matched.
	 */
	async function matchPayables() {
		if (!on || typeof ctx.tags.entries !== "function") return 0;
		const { rows } = await q(
			`SELECT id, statement_id, account_code, tx_date::text AS date, description, amount_cents, suggested_code, chosen_code, source, pays_entry_id, rejected_pays_entry_id FROM ${T("transactions")}
			  WHERE status = 'new' AND account_code <> '' AND bill_id IS NULL AND transfer_tx_id IS NULL AND transfer_entry_id IS NULL
			    AND (pays_entry_id IS NOT NULL OR chosen_code IS NULL)`,
		);
		if (rows.length === 0) return 0;
		const entries = await owedEntries();
		const accounts = await accountsByCode();
		const open = new Set(entries.filter((e) => !hasTag(e, "paid") && e.reversed_by_id == null).map((e) => String(e.id)));
		const taken = new Set();
		for (const r of rows.filter((x) => x.pays_entry_id !== null)) {
			if (!open.has(String(r.pays_entry_id))) {
				await forget(r.id);
				continue;
			}
			taken.add(String(r.pays_entry_id));
			// The entry's line may have moved since the offer (into the customer's or vendor's own account,
			// Ledger 0.31.0): the suggestion follows the account it is in now.
			if (r.source !== "tag" || r.chosen_code) continue;
			const c = payableCandidates(r, entries.filter((e) => String(e.id) === String(r.pays_entry_id)), accounts, ctx.id)[0];
			if (c && c.account_code !== r.suggested_code) await q(`UPDATE ${T("transactions")} SET suggested_code = $2 WHERE id = $1 AND status = 'new' AND source = 'tag' AND pays_entry_id = $3`, [r.id, c.account_code, String(r.pays_entry_id)]);
		}
		const pairs = assignPayables(
			rows.filter((r) => r.pays_entry_id === null),
			entries.filter((e) => !taken.has(String(e.id))),
			accounts,
			ctx.id,
			(r, c) => r.rejected_pays_entry_id === null || String(r.rejected_pays_entry_id) !== String(c.entry_id),
		);
		let n = 0;
		for (const { row, candidate: c } of pairs) {
			const what = c.role === "customer" ? "invoice" : "bill";
			const reason = `pays ${c.who?.name ? `${c.who.name}'s ${what}` : `the ${what}`} in entry #${c.entry_id}${c.reference ? ` (${c.reference})` : ""}, tagged ${c.overdue ? "overdue" : c.role === "customer" ? "billed" : "for a vendor"}`;
			const { rowCount } = await q(
				`UPDATE ${T("transactions")} SET pays_entry_id = $2, suggested_code = $3, confidence = $4, reason = $5, source = 'tag', error = NULL, new_account = NULL
				  WHERE id = $1 AND status = 'new' AND bill_id IS NULL AND chosen_code IS NULL AND pays_entry_id IS NULL`,
				[row.id, String(c.entry_id), c.account_code, c.named ? 0.9 : 0.7, reason.slice(0, 200)],
			);
			n += rowCount;
		}
		if (n > 0) ctx.log.info("rows matched to entries tagged as owed", { matches: n });
		return n;
	}

	/** Takes the offer off a row (and its suggestion, when the offer made it). Returns its statement id. */
	async function forget(txId, { rejected = false } = {}) {
		const { rows } = await q(
			`UPDATE ${T("transactions")} SET rejected_pays_entry_id = CASE WHEN $2 THEN pays_entry_id ELSE rejected_pays_entry_id END, pays_entry_id = NULL,
			        suggested_code = CASE WHEN source = 'tag' THEN NULL ELSE suggested_code END,
			        confidence = CASE WHEN source = 'tag' THEN NULL ELSE confidence END,
			        reason = CASE WHEN source = 'tag' THEN '' ELSE reason END,
			        source = CASE WHEN source = 'tag' THEN '' ELSE source END
			  WHERE id = $1 AND status = 'new' AND pays_entry_id IS NOT NULL RETURNING statement_id`,
			[String(txId), rejected],
		);
		return rows[0]?.statement_id ?? null;
	}

	/**
	 * At posting: the entry this row pays, when it still can. t: { pays_entry_id, account_code, code,
	 * amount_cents }. The row must book to the entry's receivable or payable line for its whole
	 * amount, and the entry must not be paid or reversed. Returns { entry_id, role, who,
	 * account_code } or null. account_code is the account that line sits in now, which the row is
	 * booked to: the customer's or vendor's own account when Ledger has moved the line there since
	 * the row was offered accounts receivable or payable (Ledger 0.31.0).
	 */
	async function payableFor(t) {
		if (!on || t.pays_entry_id === null || t.pays_entry_id === undefined) return null;
		const e = await ctx.ledger.getJournalEntry(Number(t.pays_entry_id)).catch(() => null);
		if (!e) return null;
		const tags = e.tags ?? (await of(e.id)) ?? [];
		const accounts = await accountsByCode();
		const c = payableCandidates({ account_code: t.account_code, date: String(e.entry_date).slice(0, 10), description: "", amount_cents: t.amount_cents }, [await withLeft({ ...e, tags })], accounts, ctx.id).find((x) => sameControl(t.code, x.account_code, accounts));
		return c ? { entry_id: e.id, role: c.role, who: c.who, account_code: c.account_code } : null;
	}

	/**
	 * A person posted the row that pays it: the entry it pays is "paid", and the new entry says who
	 * it is with (unless it was posted with that customer or vendor already). amount: what the row
	 * pays of it, in cents.
	 */
	async function paidBy(pays, entry, user, amount = null) {
		// Ledger 0.33.0: the new entry is linked as a payment of the entry it pays, and Ledger tags that
		// one paid (or partially paid). Before: tagged "paid" here, and the two entries linked.
		if (!(await linkPayment(pays.entry_id, entry.id, amount, `paid by a statement row (${ctx.name})`, user))) {
			await set(pays.entry_id, "paid", { note: `paid by entry #${entry.id}` }, user);
			await relate(entry.id, pays.entry_id, `payment of entry #${pays.entry_id}`, user);
		}
		if (pays.who?.id) await tagWho(entry, pays.role, pays.who.id, user);
	}

	/**
	 * Links two journal entries to each other (Ledger 0.28.0), so each shows on the other's page,
	 * without saying one pays the other: a duplicate and the entry kept, the two sides of a bill's
	 * stand-in, and on a Ledger before 0.33.0 a payment and the entry it pays. Nothing on an older Ledger;
	 * a failure never undoes the work.
	 */
	async function relate(entryId, otherId, note, user) {
		if (typeof ctx.ledger?.relateEntries !== "function" || !entryId || !otherId || String(entryId) === String(otherId)) return false;
		try {
			await ctx.ledger.relateEntries(entryId, otherId, { note: String(note ?? "").slice(0, 200) }, user);
			return true;
		} catch (err) {
			ctx.log.warn("could not link two journal entries", { entry: String(entryId), other: String(otherId), err: String(err?.message || err) });
			return false;
		}
	}

	/**
	 * Tags an entry with its customer or vendor (the tag other modules and Ledger's filters go by),
	 * also when the entry was posted with that entity, unless it already has that tag. An entry with
	 * a line in a customer's or vendor's own account (Ledger 0.31.0) is left alone: the account says
	 * whose it is. One with a line in accounts receivable or payable gets no tag either: Ledger
	 * moves that line into the customer's or vendor's own account instead.
	 */
	async function tagWho(entry, role, entityId, user) {
		if (!on || !entityId || !entry?.id) return false;
		const tags = entry.tags ?? (await of(entry.id));
		if (saidByAccount(tags, role) || tags?.some((t) => t.tag === role && Number(t.entity?.id) === Number(entityId))) return false;
		return set(entry.id, role, { entity_id: Number(entityId) }, user);
	}

	/**
	 * Once per organization: payments posted for bills and receipts before 0.20.2 get their vendor's
	 * tag (they were posted with the vendor, but not tagged). module_state remembers.
	 */
	async function backfillPaymentVendors() {
		if (!on) return 0;
		const { rows: done } = await q(`SELECT 1 FROM ${T("module_state")} WHERE key = 'payment_vendor_tags'`);
		if (done.length > 0) return 0;
		const { rows } = await q(
			`SELECT DISTINCT t.journal_entry_id AS entry_id, b.vendor_entity_id
			   FROM ${T("transactions")} t JOIN ${T("bills")} b ON b.id = t.bill_id
			  WHERE t.status = 'posted' AND t.journal_entry_id IS NOT NULL AND b.vendor_entity_id IS NOT NULL`,
		);
		let n = 0;
		for (const r of rows) if (await tagWho({ id: r.entry_id }, "vendor", r.vendor_entity_id)) n++;
		await q(`INSERT INTO ${T("module_state")} (key, value) VALUES ('payment_vendor_tags', $1::jsonb) ON CONFLICT (key) DO NOTHING`, [JSON.stringify({ at: new Date().toISOString(), tagged: n })]);
		return n;
	}

	return { on, ownAccounts, ratesOn, paymentsOn, managed, linkPayment, unlinkPayment, payments, linkBillPayments, backfillPayments, unpaid, paidByTag, syncItems, dropRate, set, remove, billEntry, syncBill, clearStatus, clearLinked, vendorChanged, backfill, backfillPaymentVendors, listen, matchPayables, forget, payableFor, paidBy, tagWho, relate, BILL };
}

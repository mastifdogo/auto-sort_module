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
// On a Ledger without ctx.tags every function here does nothing.

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
 * 0.31.0), which is where the row is booked.
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
		if ((e.links ?? []).some((l) => l.module_id === moduleId)) continue;
		if (!(deposit ? hasTag(e, "billed") || hasTag(e, "overdue") : hasTag(e, "vendor") || hasTag(e, "overdue"))) continue;
		const ago = days(row.date) - days(e.entry_date);
		if (ago < -10 || ago > 400) continue;
		const lines = e.lines.filter((l) => {
			const a = accounts.get(l.account_code);
			if (!a || a.is_active === false || a.hidden || l.account_code === row.account_code || (currency && a.currency !== currency)) return false;
			return deposit ? a.type === "asset" && BigInt(l.debit_cents) === abs : a.type === "liability" && BigInt(l.credit_cents) === abs;
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
	// Bills: the tags on a bill's entry follow the bill
	// -----------------------------------------------------------------------

	/** The entry other modules would look at for this bill: the payable entry, else the one it's recorded in. */
	const billEntry = (b) => b.journal_entry_id ?? b.paid_entry_id ?? null;
	const BILL = `id, kind, status, vendor, due_date::text AS due_date, journal_entry_id, paid_entry_id, vendor_entity_id, tags_synced_at`;

	/** Someone else tagged the bill's entry "paid": the bill is paid here too. Nothing is posted. */
	async function paidElsewhere(billId, by) {
		const { rowCount } = await q(
			`UPDATE ${T("bills")} SET status = 'paid', paid_at = now(), paid_by_tag = true, paid_tag_by = $2, updated_at = now() WHERE id = $1 AND status IN ('new', 'open')`,
			[billId, String(by || "a person").slice(0, 100)],
		);
		return rowCount > 0;
	}
	const whoSet = (t) => (t?.module_id ? `module ${t.module_id}` : t?.set_by || "a person");

	/**
	 * Brings the tags on a bill's entry in line with the bill: its vendor, "paid" while it is paid,
	 * "overdue" while it's an approved bill past its due date. A "paid" someone else put on the entry
	 * of an unpaid bill makes the bill paid instead. b: a bills row (BILL columns, or getBill's).
	 * Returns "paid" when the bill became paid that way.
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
		if (paid && paid.module_id !== ctx.id && ["new", "open"].includes(status) && (await paidElsewhere(b.id, whoSet(paid)))) {
			status = "paid";
			became = "paid";
		}
		const vendor = b.vendor_entity_id === null || b.vendor_entity_id === undefined ? null : Number(b.vendor_entity_id);
		// A line in a vendor's own account says whose the entry is (Ledger 0.31.0): no tag then. Else the
		// tag is set; where the entry has a line in accounts payable, Ledger moves it into the vendor's account.
		if (vendor && !saidByAccount(tags, "vendor") && !tags.some((t) => t.tag === "vendor" && Number(t.entity?.id) === vendor)) await set(entry, "vendor", { entity_id: vendor }, user);
		if (status === "paid") {
			// Its payment is another entry when the bill went through payables: the note says which.
			const note = b.journal_entry_id && b.paid_entry_id ? `payment in entry #${b.paid_entry_id}` : "";
			if (!paid) await set(entry, "paid", note ? { note } : {}, user);
		} else {
			if (paid) await remove(entry, "paid");
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
			if (!["paid", "vendor"].includes(c.tag)) return;
			const { rows } = await q(`SELECT ${BILL} FROM ${T("bills")} WHERE journal_entry_id = $1 OR (journal_entry_id IS NULL AND paid_entry_id = $1) ORDER BY id`, [String(c.entry_id)]);
			for (const b of rows) {
				if (c.tag === "vendor") {
					if (c.action !== "set" || b.vendor_entity_id !== null || !c.entity_id) continue;
					const name = (await of(c.entry_id))?.find((t) => t.tag === "vendor" && t.entity?.id === Number(c.entity_id))?.entity?.name ?? "";
					await q(`UPDATE ${T("bills")} SET vendor_entity_id = $2, vendor = CASE WHEN vendor = '' THEN $3 ELSE vendor END, updated_at = now() WHERE id = $1 AND vendor_entity_id IS NULL`, [b.id, String(c.entity_id), name.slice(0, 200)]);
					ctx.log.info("bill vendor filled from a tag", { bill: String(b.id), entry: String(c.entry_id), entity: String(c.entity_id) });
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
		return [...seen.values()];
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
		const c = payableCandidates({ account_code: t.account_code, date: String(e.entry_date).slice(0, 10), description: "", amount_cents: t.amount_cents }, [{ ...e, tags }], accounts, ctx.id).find((x) => sameControl(t.code, x.account_code, accounts));
		return c ? { entry_id: e.id, role: c.role, who: c.who, account_code: c.account_code } : null;
	}

	/**
	 * A person posted the row that pays it: the entry it pays is "paid", and the new entry says who
	 * it is with (unless it was posted with that customer or vendor already).
	 */
	async function paidBy(pays, entry, user) {
		await set(pays.entry_id, "paid", { note: `paid by entry #${entry.id}` }, user);
		await relate(entry.id, pays.entry_id, `payment of entry #${pays.entry_id}`, user);
		if (pays.who?.id) await tagWho(entry, pays.role, pays.who.id, user);
	}

	/**
	 * Links two journal entries to each other (Ledger 0.28.0), so each shows on the other's page:
	 * a payment and the entry it pays, a duplicate and the entry kept. Nothing on an older Ledger;
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

	return { on, ownAccounts, ratesOn, syncItems, dropRate, set, remove, billEntry, syncBill, clearStatus, clearLinked, vendorChanged, backfill, backfillPaymentVendors, listen, matchPayables, forget, payableFor, paidBy, tagWho, relate, BILL };
}

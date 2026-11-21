// Taxes chosen on the line items of bills and receipts: a short list a person sets up (name,
// rate in percent, and the account the tax is booked to when it is claimed back). Ledger has no
// tax list of its own, so this module keeps one per organization (table taxes).

import { pickable } from "./categorize.mjs";

/** "5", "9.975", 13 → the rate in ten-thousandths of a percent (bigint), or null when it isn't a rate above 0 up to 100 with at most 4 decimals. */
export function parseRate(v) {
	const s = typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "string" ? v.trim().replace(/\s*%$/, "") : "";
	const m = /^(\d{1,3})(?:\.(\d{1,4}))?$/.exec(s);
	if (!m) return null;
	const e4 = BigInt(m[1]) * 10000n + BigInt((m[2] ?? "").padEnd(4, "0"));
	return e4 > 0n && e4 <= 1000000n ? e4 : null;
}

/** A rate as people write it: "5", "9.975". */
export function rateText(v) {
	const e4 = parseRate(String(v));
	if (e4 === null) return String(v);
	const frac = (e4 % 10000n).toString().padStart(4, "0").replace(/0+$/, "");
	return `${e4 / 10000n}${frac ? `.${frac}` : ""}`;
}

/** The tax on an amount in cents, rounded half up to a cent. rate: percent as text or number. */
export function taxCents(baseCents, rate) {
	const e4 = parseRate(String(rate));
	if (e4 === null) return 0n;
	return (BigInt(baseCents) * e4 + 500000n) / 1000000n;
}

/** The tax inside an amount that includes it, rounded half up to a cent. */
export function includedTaxCents(grossCents, rate) {
	const e4 = parseRate(String(rate));
	if (e4 === null) return 0n;
	const d = 1000000n + e4;
	return (BigInt(grossCents) * e4 + d / 2n) / d;
}

/** A tax as it is shown and written on lines: "GST 5%". */
export const taxLabel = (t) => (/\d\s*%/.test(t.name) ? t.name : `${t.name} ${t.rate}%`);

/** h: { q, T, bad }. Returns { listTaxes(), taxesById() }. */
export function registerTaxes(ctx, h) {
	const { q, T, bad } = h;
	const COLUMNS = `t.id, t.name, t.rate::text AS rate, t.account_code, t.active,
		(SELECT count(*)::int FROM ${T("bill_items")} i WHERE i.tax_id = t.id) + (SELECT count(*)::int FROM ${T("bills")} b WHERE b.tax_id = t.id) AS used`;

	async function listTaxes() {
		const { rows } = await q(`SELECT ${COLUMNS} FROM ${T("taxes")} t ORDER BY t.active DESC, lower(t.name)`);
		return rows.map((r) => ({ ...r, id: String(r.id), rate: rateText(r.rate) }));
	}
	const taxesById = async () => new Map((await listTaxes()).map((t) => [t.id, t]));

	async function getTax(id) {
		if (!/^\d{1,18}$/.test(String(id))) throw new ctx.HttpError(404, "no such tax");
		const t = (await taxesById()).get(String(id));
		if (!t) throw new ctx.HttpError(404, "no such tax");
		return t;
	}

	/** Checks the fields a request gives; → the ones to save. */
	async function fields(body, current) {
		if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("send {name, rate, account_code}");
		const f = {};
		if (body.name !== undefined || !current) {
			if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 40) throw bad("name must be text of 1 to 40 characters, e.g. GST 5%");
			f.name = body.name.trim();
		}
		if (body.rate !== undefined || !current) {
			const e4 = parseRate(body.rate);
			if (e4 === null) throw bad("rate must be a percentage above 0, up to 100, with at most 4 decimals, e.g. 5 or 9.975");
			f.rate = rateText(String(body.rate));
		}
		if (body.account_code !== undefined) {
			if (body.account_code !== null && typeof body.account_code !== "string") throw bad("account_code must be an account's code, or empty when the tax isn't claimed back");
			const code = (body.account_code ?? "").trim();
			if (code) {
				const a = (await ctx.ledger.listAccounts({ includeInactive: true })).find((x) => x.code === code);
				if (!a || !a.is_active || !pickable(a)) throw bad("choose an active account for the tax");
			}
			f.account_code = code || null;
		}
		if (body.active !== undefined) {
			if (typeof body.active !== "boolean") throw bad("active must be true or false");
			f.active = body.active;
		}
		// What it books is fixed once it is on a line: bills already worked out with it stay right.
		if (current && current.used > 0) {
			if ("rate" in f && f.rate !== current.rate) throw new ctx.HttpError(409, `${current.name} is in use ${current.used} time${current.used === 1 ? "" : "s"}, so its rate can't change; turn it off and add a new tax`);
			if ("account_code" in f && f.account_code !== current.account_code) throw new ctx.HttpError(409, `${current.name} is in use ${current.used} time${current.used === 1 ? "" : "s"}, so its account can't change; turn it off and add a new tax`);
		}
		return f;
	}
	const taken = (err) => (err?.code === "23505" ? new ctx.HttpError(409, "there is a tax with that name already") : err);

	// GET /taxes: the taxes to choose from on a line item (inactive ones too, marked).
	ctx.route("GET", "/taxes", async () => ({ data: await listTaxes() }));

	// POST /taxes {name, rate, account_code?}: a new tax. rate is a percentage; account_code is where
	// the tax is booked (tax you claim back), empty when it stays with the item's category.
	ctx.route("POST", "/taxes", async (req) => {
		const f = await fields(req.body, null);
		try {
			const { rows } = await q(`INSERT INTO ${T("taxes")} (name, rate, account_code, created_by) VALUES ($1, $2, $3, $4) RETURNING id`, [f.name, f.rate, f.account_code ?? null, req.user.username]);
			ctx.log.info("tax added", { tax: String(rows[0].id), name: f.name, rate: f.rate, by: req.user.username });
			return { tax: await getTax(rows[0].id) };
		} catch (err) { throw taken(err); }
	});

	// PUT /taxes/:id {name?, rate?, account_code?, active?}: rate and account only while no line uses it.
	ctx.route("PUT", "/taxes/:id", async (req) => {
		const cur = await getTax(req.params.id);
		const f = await fields(req.body, cur);
		const next = { ...cur, ...f };
		try {
			await q(`UPDATE ${T("taxes")} SET name = $2, rate = $3, account_code = $4, active = $5 WHERE id = $1`, [cur.id, next.name, next.rate, next.account_code, next.active]);
		} catch (err) { throw taken(err); }
		return { tax: await getTax(cur.id) };
	});

	// DELETE /taxes/:id: only one no line item uses; a used one is turned off instead (active: false).
	ctx.route("DELETE", "/taxes/:id", async (req) => {
		const cur = await getTax(req.params.id);
		if (cur.used > 0) throw new ctx.HttpError(409, `${cur.name} is in use ${cur.used} time${cur.used === 1 ? "" : "s"}; turn it off instead`);
		await q(`DELETE FROM ${T("taxes")} WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM ${T("bill_items")} WHERE tax_id = $1) AND NOT EXISTS (SELECT 1 FROM ${T("bills")} WHERE tax_id = $1)`, [cur.id]);
		ctx.log.info("tax removed", { tax: cur.id, name: cur.name, by: req.user.username });
		return { ok: true };
	});

	return { listTaxes, taxesById };
}

// Bills and receipts: uploaded (PDF, photo or saved email) or sent by another
// module, Ledger's LLM API (ctx.llm) reads them, you approve them, and statement
// transactions that pay them are matched automatically.
//
// Approving a bill with an accounts-payable account configured posts
// Dr <bill account> / Cr <payable>; the matched bank payment then books
// Dr <payable> / Cr <bank>. Without a payable account, bills are only
// tracked and the payment books straight to the bill's account.

import { formatCents, pickable } from "./categorize.mjs";
import { dashboard } from "./dashboard.mjs";
import { assignMatches, billInfoOf, draftFromBillInfo, extractBill, findDuplicate, imageType, normalizeItem, readItems, readStatementBill, suggestSplit } from "./bills.mjs";
import { accountHint, extractPdfStatement, shouldFlip, sourceKey } from "./email-statements.mjs";
import { MODULE_KEY, billData, billFromData, billInfoData, billInfoFromData, statementData } from "./extraction.mjs";
import { parseEmail } from "./mime.mjs";
import { parseAmount, parseDate } from "./parse.mjs";
import { markAmended } from "./ledger-sync.mjs";

const MAX_DOCUMENT_BYTES = 5 << 20;

/**
 * How a bill is booked when its line items have accounts of their own: one line per categorized
 * item, and one for the rest (items left to the bill, tax, a tip) on the bill's own account.
 * → { lines: [{description, amount, account_code}] } ([] when no item has an account), or
 * { error } when it can't be done. Pure: bill = { amount_cents, account_code, kind }.
 */
export function linesFromItems(bill, items) {
	const own = items.filter((it) => it.account_code);
	if (own.length === 0) return { lines: [] };
	const what = bill.kind === "receipt" ? "receipt" : "bill";
	if (bill.amount_cents == null) return { error: `enter the ${what}'s amount before giving items their own category` };
	const lines = [];
	let sum = 0n;
	for (const it of own) {
		if (it.amount_cents == null || BigInt(it.amount_cents) <= 0n) return { error: `"${it.description}" needs an amount above zero to have its own category` };
		sum += BigInt(it.amount_cents);
		lines.push({ description: String(it.description).slice(0, 200), amount: BigInt(it.amount_cents), account_code: it.account_code });
	}
	const rest = BigInt(bill.amount_cents) - sum;
	if (rest < 0n) return { error: `the categorized items add up to ${formatCents(sum)}, more than the ${what}'s ${formatCents(BigInt(bill.amount_cents))}` };
	if (rest > 0n) {
		if (!bill.account_code) return { error: `choose the ${what}'s own category too: ${formatCents(rest)} isn't covered by the categorized items` };
		lines.push({ description: own.length === items.length ? "Rest (tax and other charges)" : "Other items, tax and other charges", amount: rest, account_code: bill.account_code });
	}
	return { lines };
}
const billColumns = (SCHEMA) => `b.id, b.kind, b.status, b.vendor, b.invoice_number, b.bill_date::text AS bill_date, b.due_date::text AS due_date, b.amount_cents,
	b.currency, b.account_code, b.confidence, b.summary, b.error, b.source, b.mail_from, b.mail_subject, b.mail_date,
	d.document_id, d.file_name AS document_name, (d.bill_id IS NOT NULL) AS has_document, d.content_type AS document_type, b.journal_entry_id, b.ap_account, b.paid_entry_id, b.paid_at, b.updated_by, b.created_at, b.updated_at,
	b.billable, b.customer_name, b.customer_ref, b.statement_id, b.vendor_entity_id, b.customer_entity_id, b.paid_by_tag, b.paid_tag_by, b.tags_synced_at, b.lines_from_items,
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
	const dash = dashboard(ctx);

	/** The bill options of this organization's settings. */
	async function billSettings() {
		const v = await ctx.settings.get();
		return { ap_account: String(v.ap_account ?? "").trim() };
	}

	async function accountsByCode() {
		return new Map((await ctx.ledger.listAccounts({ includeInactive: true })).map((a) => [a.code, a]));
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
		return (await ctx.ledger.listAccounts()).filter((a) => a.code !== ap && pickable(a));
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
	async function ingest(email, { source, ai, mail, kind = null, known = null, fileDoc = null, user }) {
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
		if (!x) x = await extractBill({ llm: ai.llm, readsPdf: ai.readsPdf, readsImages: ai.readsImages, email, pdfs: pdfs.slice(0, 3), images, accounts, examples: await pastVendors() });
		else if (!x.account_code) {
			// No AI: the account comes from the vendor's past bills, when there are any.
			const past = (await pastVendors()).find((v) => v.vendor.trim().toLowerCase() === x.vendor.trim().toLowerCase());
			if (past && accounts.some((a) => a.code === past.account_code)) x = { ...x, account_code: past.account_code };
		}
		const { rows: recent } = await q(
			`SELECT id, vendor, invoice_number, bill_date::text AS bill_date, due_date::text AS due_date, amount_cents FROM ${T("bills")}
			  WHERE status <> 'ignored' AND created_at > now() - interval '180 days'`,
		);
		const dup = findDuplicate(x, recent);
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
				known ? x.summary || "Read from the file before; the AI wasn't asked again." : x.summary,
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
		return { outcome: (kind ?? x.kind) === "receipt" ? "receipt" : "bill", bill_id: rows[0].id, read: known ? "extracted" : "ai" };
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

	/** The account a payment of this bill is booked to. */
	const targetOf = (b) => b.ap_account || b.account_code || null;

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
			        b.paid_entry_id, b.vendor_entity_id, b.tags_synced_at,
			        (SELECT d.document_id FROM ${T("bill_documents")} d WHERE d.bill_id = b.id) AS document_id,
			        EXISTS (SELECT 1 FROM ${T("transactions")} t WHERE t.bill_id = b.id AND t.status = 'new') AS matched
			   FROM ${T("bills")} b
			  WHERE b.status IN ('new', 'open') OR b.updated_at > now() - interval '3 days'`,
		);
		for (const b of rows) {
			const key = `bill-${b.id}`;
			// The tags on the bill's entry (Ledger 0.23.0) and on its document (0.27.0) follow it: vendor, posted,
			// paid, and overdue as days pass. Its entry or document tagged "paid" by someone else meanwhile: the bill is paid.
			if ((await tags.syncBill(b)) === "paid") b.status = "paid";
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
					`UPDATE ${T("transactions")} SET bill_id = $2, suggested_code = $3, confidence = $4, reason = $5, source = 'bill', error = NULL
					  WHERE id = $1 AND status = 'new' AND bill_id IS NULL AND chosen_code IS NULL`,
					[tx.id, bill.id, targetOf(bill), score, reason.slice(0, 200)],
				);
				n++;
			}
		}
		if (n > 0) ctx.log.info("bills matched", { matches: n });
		return n;
	}

	/** Called after a statement transaction is posted: marks its bill paid if it was booked as the bill's payment. */
	async function onPosted(txId, code, entryId, user) {
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
		return rows.length > 0;
	}

	/** Unlinks unposted transactions from a bill and re-categorises their statements. */
	async function unlink(billId) {
		const { rows } = await q(
			`UPDATE ${T("transactions")} SET bill_id = NULL,
			        suggested_code = CASE WHEN source = 'bill' THEN NULL ELSE suggested_code END,
			        confidence = CASE WHEN source = 'bill' THEN NULL ELSE confidence END,
			        reason = CASE WHEN source = 'bill' THEN '' ELSE reason END,
			        source = CASE WHEN source = 'bill' THEN '' ELSE source END
			  WHERE bill_id = $1 AND status IN ('new', 'skipped') RETURNING statement_id`,
			[billId],
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
		return rows[0];
	}

	async function paymentOf(id) {
		const { rows } = await q(
			`SELECT t.id, t.statement_id, t.account_code, t.tx_date::text AS date, t.description, t.amount_cents, t.status, t.journal_entry_id,
			        COALESCE(t.chosen_code, t.suggested_code) AS code, t.confidence
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
			        (SELECT t.status FROM ${T("transactions")} t WHERE t.bill_id = b.id ORDER BY t.id DESC LIMIT 1) AS transaction_status
			   FROM ${T("bills")} b LEFT JOIN ${T("bill_documents")} d ON d.bill_id = b.id WHERE ${where}
			  ORDER BY (b.status IN ('new', 'open')) DESC, COALESCE(b.due_date, b.bill_date, b.created_at::date) ASC, b.id DESC LIMIT 500`,
			[status, kind],
		);
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
		// The payable entry may have been changed by a person in Ledger (0.19.5): it credits the AP account.
		if (out.ap_account) await markAmended(ctx, [out], out.ap_account, { sign: -1n, dateOf: (b) => b.bill_date ?? b.due_date ?? null });
		const payments = await paymentOf(bill.id);
		await markAmended(ctx, payments, (p) => p.account_code);
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
		// Lines made from the items' categories follow the bill: checked here that they still can.
		if (current?.lines_from_items && ("amount_cents" in f || "account_code" in f)) {
			const plan = linesFromItems({ ...current, ...f }, await itemsOf(current.id));
			if (plan.error) throw new ctx.HttpError(409, `${plan.error}; change the items' categories first`);
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
		const { rows } = await q(`INSERT INTO ${T("bills")} (source, vendor, updated_by, statement_id) VALUES ($1, $2, $3, $4) RETURNING id`, [
			statementId ? "statement" : "upload",
			f.vendor,
			req.user.username,
			statementId,
		]);
		await applyFields(rows[0].id, f, req.user.username);
		await linkEntities(rows[0].id, { create: true });
		// A person said what the statement says is owed: that is kept with the statement's document.
		if (statementId) await saveStatementOwed(statementId, await getBill(rows[0].id), req.user);
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
	async function ingestDocument({ filename, data, source, kind = null, from = "", note = "", documentId = null, user, mail: fromMail = null }) {
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
			const known = docId === null ? null : billFromData((await h.files.extractedOf(docId))?.data);
			const subject = fromMail?.subject || note || filename;
			if (known) {
				email ??= { subject, from: fromMail?.from ?? from, date: null, messageId: null, text: note, attachments: [] };
				const r = await ingest(email, { source, ai: null, mail, kind, known, fileDoc, user });
				if (r.outcome === "duplicate") await undo();
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
			const r = await ingest(email, { source, ai, mail, kind, fileDoc, user });
			if (r.outcome === "duplicate") await undo();
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
		const bankish = (await ctx.ledger.listAccounts()).filter((a) => (a.type === "asset" || a.type === "liability") && pickable(a));
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
			f.status = b.status;
			if (b.status === "paid" && bill.status !== "paid") f.paid_at = new Date();
			// Marked paid or reopened by a person here: no longer "paid because its entry was tagged".
			if (b.status !== bill.status && (bill.paid_by_tag || bill.paid_tag_by)) Object.assign(f, { paid_by_tag: false, paid_tag_by: null });
		}
		await applyFields(bill.id, f, req.user.username);
		if (bill.lines_from_items && ("amount_cents" in f || "account_code" in f)) {
			const plan = linesFromItems({ ...bill, ...f }, await itemsOf(bill.id));
			if (!plan.error) await writeLines(bill.id, plan.lines, true);
		}
		// A person saved the vendor or customer: it belongs in Ledger's list of customers and vendors.
		if ("vendor" in f || "customer_name" in f) await linkEntities(bill.id, { create: true });
		if (f.status === "ignored" || f.amount_cents !== undefined || f.account_code !== undefined) await unlink(bill.id);
		// The tags on its entry follow (Ledger 0.23.0): reopened, it isn't "paid" any more; a changed
		// vendor replaces the old one; marked paid, it is "paid" (the sync below sets what's missing).
		const after = await getBill(bill.id);
		const entry = tags.billEntry(after);
		if (bill.status === "paid" && after.status !== "paid") {
			await tags.remove(entry, "paid");
			await h.dtags.clearPaid(bill.id);
		}
		if (bill.vendor_entity_id && String(bill.vendor_entity_id) !== String(after.vendor_entity_id ?? "")) await tags.remove(entry, "vendor", { entity_id: Number(bill.vendor_entity_id) });
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

	// Approve: the details are right. With a payable account set, also post the bill to payables.
	ctx.route("POST", "/bills/:id/approve", async (req) => {
		const bill = await getBill(req.params.id);
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
		const accounts = await accountsByCode();
		const account = accounts.get(bill.account_code);
		if (account?.currency !== bill.currency) throw bad(`account ${bill.account_code} is in ${account?.currency}, the bill in ${bill.currency}`);
		if (bill.kind === "bill" && mail.ap_account && !bill.journal_entry_id) {
			const ap = accounts.get(mail.ap_account);
			if (!ap || !ap.is_active || ap.type !== "liability") {
				throw new ctx.HttpError(409, `the accounts payable account "${mail.ap_account}" under Settings → ${ctx.name} must be an active liability account`);
			}
			if (ap.currency !== bill.currency) throw bad(`the payable account ${mail.ap_account} is in ${ap.currency}, not ${bill.currency}; bills in ${bill.currency} can't be posted to it`);
			const date = bill.bill_date ?? bill.due_date ?? today();
			const splitLines = await linesOf(bill.id);
			const entry = await ctx.ledger.createJournalEntry(
				{
					entry_date: date,
					description: `${bill.vendor || "Bill"}${bill.invoice_number ? ` invoice ${bill.invoice_number}` : " bill"}`.slice(0, 500),
					reference: (bill.invoice_number ? `bill ${bill.invoice_number}` : `bill ${bill.id}`).slice(0, 100),
					lines: [
						...(splitLines.length > 0
							? splitLines.map((l) => ({ account_code: l.account_code, debit_cents: l.amount_cents, credit_cents: 0n, memo: l.description.slice(0, 500) }))
							: [{ account_code: bill.account_code, debit_cents: bill.amount_cents, credit_cents: 0n, memo: bill.due_date ? `due ${bill.due_date}` : "" }]),
						{ account_code: ap.code, debit_cents: 0n, credit_cents: bill.amount_cents, memo: "" },
					],
					links: [billLink(bill)],
					...(vendorEntity ? { entity_id: Number(vendorEntity) } : {}),
				},
				req.user,
			);
			await q(`UPDATE ${T("bills")} SET journal_entry_id = $2, ap_account = $3 WHERE id = $1`, [bill.id, entry.id, ap.code]);
		}
		await applyFields(bill.id, { status: bill.status === "new" ? "open" : bill.status, error: null }, req.user.username);
		// Its entry says who it is with, and "overdue" when it already is (Ledger 0.23.0).
		await tags.syncBill(await getBill(bill.id), req.user);
		// A person approved what was read: it is saved with the document (Ledger's extracted data), for every module.
		await saveBillExtraction(bill.id, req.user);
		await autoMatch();
		// A person approved what the AI read: the file it came from (if another module sent it) is done.
		await h.settleFile?.({ billId: bill.id }, "done", `approved as ${bill.kind} #${bill.id} by ${req.user.username}`, req.user.username);
		return getBill(bill.id);
	});

	ctx.route("POST", "/bills/:id/unapprove", async (req) => {
		const bill = await getBill(req.params.id);
		if (bill.status === "paid") throw new ctx.HttpError(409, "this bill is paid; reverse the payment entry in the journal first");
		if (bill.journal_entry_id) {
			await ctx.ledger.reverseJournalEntry(bill.journal_entry_id, { description: `Undo ${bill.vendor || "bill"} bill approval`.slice(0, 500) }, req.user);
			// The reversed entry is no longer a bill to pay: not "overdue", not "paid".
			await tags.clearStatus(bill.journal_entry_id);
			await q(`UPDATE ${T("bills")} SET journal_entry_id = NULL, ap_account = NULL WHERE id = $1`, [bill.id]);
		}
		await applyFields(bill.id, { status: "new" }, req.user.username);
		await unlink(bill.id);
		// The reversed entry doesn't carry its items any more.
		await tags.syncItems(await getBill(bill.id), req.user);
		await autoMatch();
		return getBill(bill.id);
	});

	// Unposted outgoing statement transactions with this bill's amount (for manual matching).
	ctx.route("GET", "/bills/:id/candidates", async (req) => {
		const bill = await getBill(req.params.id);
		if (bill.amount_cents === null) return { data: [] };
		const { rows } = await q(
			`SELECT t.id, t.statement_id, t.account_code, t.tx_date::text AS date, t.description, t.amount_cents, t.bill_id
			   FROM ${T("transactions")} t WHERE t.status = 'new' AND t.amount_cents = $1 ORDER BY t.tx_date DESC LIMIT 50`,
			[(-BigInt(bill.amount_cents)).toString()],
		);
		return { data: rows };
	});

	ctx.route("POST", "/bills/:id/match", async (req) => {
		const bill = await getBill(req.params.id);
		const txId = String(req.body?.transaction_id ?? "");
		if (!/^\d+$/.test(txId)) throw bad("transaction_id is required");
		await matchBillTx(bill, txId, "matched by hand");
		return { bill: await getBill(bill.id), payments: await paymentOf(bill.id) };
	});

	/** Links an unposted statement row to a bill as its payment (by hand, or an approved match). */
	async function matchBillTx(bill, txId, how) {
		const target = targetOf(bill);
		if (!target) throw bad("choose the bill's account first");
		if (!["new", "open"].includes(bill.status)) throw new ctx.HttpError(409, `this ${bill.kind} is ${bill.status}`);
		if (bill.paid_entry_id) throw new ctx.HttpError(409, `this ${bill.kind} is already linked to journal entry #${bill.paid_entry_id}`);
		await unlink(bill.id);
		const { rowCount } = await q(
			`UPDATE ${T("transactions")} SET bill_id = $2, chosen_code = $3, source = 'bill', reason = $4, error = NULL WHERE id = $1 AND status = 'new'`,
			[String(txId), bill.id, target, `pays ${bill.vendor || "bill"} (${how})`.slice(0, 200)],
		);
		if (rowCount === 0) throw bad("that transaction is not waiting to be posted");
		await syncBillTodos();
	}

	/**
	 * The bill or receipt is already in the journal (entered by hand, or by another module): link it
	 * to that entry and count it as paid. Its unposted payment rows are unlinked.
	 */
	async function linkBillEntry(bill, entryId, user) {
		if (bill.status === "paid") throw new ctx.HttpError(409, `this ${bill.kind} is already ${bill.kind === "receipt" ? "matched" : "paid"}`);
		const e = await ctx.ledger.getJournalEntry(Number(entryId)).catch(() => null);
		if (!e) throw new ctx.HttpError(404, `no journal entry ${entryId}`);
		if (e.reversed_by_id != null || e.reverses_id != null) throw new ctx.HttpError(409, `entry #${e.id} is reversed or a reversal`);
		await unlink(bill.id);
		await q(`UPDATE ${T("bills")} SET status = 'paid', paid_entry_id = $2, paid_at = now(), paid_by_tag = false, paid_tag_by = NULL, updated_by = $3, updated_at = now() WHERE id = $1`, [bill.id, e.id, user.username]);
		await ctx.ledger.linkJournalEntry(e.id, billLink(bill), user);
		// A person said this entry records it: the bill's entry is "paid" and with its vendor.
		await tags.syncBill(await getBill(bill.id), user);
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
		if (!bill.paid_entry_id || (await paymentOf(bill.id)).some((t) => t.status === "posted")) throw new ctx.HttpError(409, "this isn't linked to a journal entry by hand");
		await ctx.ledger.unlinkJournalEntry(bill.paid_entry_id, `bill:${bill.id}`).catch(() => false);
		// Not paid after all: the payable entry loses "paid"; an entry that only recorded it loses what this module tagged.
		if (bill.journal_entry_id) await tags.remove(bill.journal_entry_id, "paid");
		else await tags.clearLinked(bill.paid_entry_id, bill.vendor_entity_id);
		await h.dtags.clearPaid(bill.id);
		await q(`UPDATE ${T("bills")} SET status = 'open', paid_entry_id = NULL, paid_at = NULL, updated_by = $2, updated_at = now() WHERE id = $1`, [bill.id, req.user.username]);
		await tags.syncItems(await getBill(bill.id), req.user);
		await autoMatch();
		return getBill(bill.id);
	});

	ctx.route("POST", "/bills/:id/unmatch", async (req) => {
		const bill = await getBill(req.params.id);
		await q(`UPDATE ${T("transactions")} SET chosen_code = NULL WHERE bill_id = $1 AND status = 'new' AND chosen_code = $2`, [bill.id, targetOf(bill)]);
		await q(`UPDATE ${T("transactions")} SET rejected_bill_id = bill_id WHERE bill_id = $1 AND status = 'new'`, [bill.id]);
		await unlink(bill.id);
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
			`SELECT id, line_no, description, quantity::text AS quantity, unit, rate_cents, amount_cents, billable, rate_entry_id, rate_tag_id, account_code
			   FROM ${T("bill_items")} WHERE bill_id = $1 ORDER BY line_no`,
			[String(billId)],
		);
		return rows.map((r) => ({ ...r, quantity: r.quantity === null ? null : String(Number(r.quantity)) }));
	}

	/** Adds line items (normalizeItem's) after the bill's existing ones. */
	async function insertItems(billId, items) {
		if (!items.length) return;
		await q(
			`INSERT INTO ${T("bill_items")} (bill_id, line_no, description, quantity, unit, rate_cents, amount_cents, billable)
			 SELECT $1, COALESCE((SELECT max(line_no) FROM ${T("bill_items")} WHERE bill_id = $1), 0) + u.n, u.d, u.q, u.u, u.r, u.a, u.b
			   FROM unnest($2::int[], $3::text[], $4::numeric[], $5::text[], $6::bigint[], $7::bigint[], $8::boolean[]) AS u(n, d, q, u, r, a, b)`,
			[
				String(billId),
				items.map((_, i) => i + 1),
				items.map((it) => it.description),
				items.map((it) => it.quantity),
				items.map((it) => it.unit ?? ""),
				items.map((it) => (it.rate_cents === null ? null : it.rate_cents.toString())),
				items.map((it) => (it.amount_cents === null ? null : it.amount_cents.toString())),
				items.map((it) => it.billable === true),
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
		const it = normalizeItem({ description: x.description, quantity: given(x.quantity) ? String(x.quantity) : "", unit, unit_price: given(x.rate) ? x.rate : "", amount: given(x.amount) ? x.amount : "" });
		if (!it) throw bad(`${at}: needs a quantity, a price or an amount`);
		return { ...it, id: x.id == null ? null : String(x.id), billable: x.billable === true, account_code: typeof x.account_code === "string" && x.account_code.trim() ? x.account_code.trim() : null };
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
		// Items with a category of their own: the bill is booked line by line. Worked out and checked
		// before anything is saved; it can only change while nothing the bill books is posted.
		if (items.some((it) => it.account_code)) {
			const accounts = await accountsByCode();
			for (const [i, it] of items.entries()) {
				if (!it.account_code) continue;
				const a = accounts.get(it.account_code);
				if (!a || !a.is_active || !pickable(a)) throw bad(`item ${i + 1}: choose an active account`);
				if (a.currency !== bill.currency) throw bad(`item ${i + 1}: account ${a.code} is in ${a.currency}, the ${bill.kind} in ${bill.currency}`);
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
			const vals = [it.description, it.quantity, it.unit, it.rate_cents === null ? null : it.rate_cents.toString(), it.amount_cents === null ? null : it.amount_cents.toString(), it.billable, i + 1, it.account_code];
			if (it.id !== null) await q(`UPDATE ${T("bill_items")} SET description = $2, quantity = $3, unit = $4, rate_cents = $5, amount_cents = $6, billable = $7, line_no = $8, account_code = $9 WHERE id = $1`, [it.id, ...vals]);
			else await q(`INSERT INTO ${T("bill_items")} (bill_id, description, quantity, unit, rate_cents, amount_cents, billable, line_no, account_code) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [bill.id, ...vals]);
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
		const items = await readItems({ llm: ai.llm, bill, document: doc });
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
		await q(`UPDATE ${T("bill_items")} SET account_code = NULL WHERE bill_id = $1 AND account_code IS NOT NULL`, [bill.id]);
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
		await q(`UPDATE ${T("bill_items")} SET account_code = NULL WHERE bill_id = $1 AND account_code IS NOT NULL`, [bill.id]);
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
	h.dtags.listen({ unlink, autoMatch, syncBillTodos, complete: (key) => dash.complete(key), entryUnpaid: (b) => tags.remove(tags.billEntry(b), "paid") });

	return { autoMatch, onPosted, ingestDocument, ingestStatementFile, linkFor, getBill, matchBillTx, linkBillEntry, linesOf, statementBillDraft, syncBillTodos, saveBillExtraction };
}

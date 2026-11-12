// Bills and receipts: uploaded (PDF, photo or saved email) or sent by another
// module, Ledger's LLM API (ctx.llm) reads them, you approve them, and statement
// transactions that pay them are matched automatically.
//
// Approving a bill with an accounts-payable account configured posts
// Dr <bill account> / Cr <payable>; the matched bank payment then books
// Dr <payable> / Cr <bank>. Without a payable account, bills are only
// tracked and the payment books straight to the bill's account.

import { formatCents } from "./categorize.mjs";
import { dashboard } from "./dashboard.mjs";
import { assignMatches, extractBill, findDuplicate, imageType, readStatementBill, suggestSplit } from "./bills.mjs";
import { accountHint, extractPdfStatement, shouldFlip, sourceKey } from "./email-statements.mjs";
import { parseEmail } from "./mime.mjs";
import { ParseError, parseAmount, parseDate, parseStatement } from "./parse.mjs";

const MAX_DOCUMENT_BYTES = 5 << 20;

const billColumns = (SCHEMA) => `b.id, b.kind, b.status, b.vendor, b.invoice_number, b.bill_date::text AS bill_date, b.due_date::text AS due_date, b.amount_cents,
	b.currency, b.account_code, b.confidence, b.summary, b.error, b.source, b.mail_from, b.mail_subject, b.mail_date,
	d.file_name AS document_name, (d.bill_id IS NOT NULL) AS has_document, d.content_type AS document_type, b.journal_entry_id, b.ap_account, b.paid_entry_id, b.paid_at, b.updated_by, b.created_at, b.updated_at,
	b.billable, b.customer_name, b.customer_ref, b.statement_id,
	(SELECT count(*)::int FROM ${SCHEMA}.bill_lines l WHERE l.bill_id = b.id) AS line_count`;

/**
 * h: { q, T, bad, ai(), requeue(statementIds), stageStatement(parsed, opts) } where ai() gives { llm, readsPdf }.
 * Returns { autoMatch, targetOf, onPosted } for the statement side.
 */
export function registerBills(ctx, h) {
	const { q, T, bad } = h;
	const BILL_COLUMNS = billColumns(ctx.schema);
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
		return (await ctx.ledger.listAccounts()).filter((a) => a.code !== ap);
	}

	/**
	 * Stages a statement another module sent. The account comes from what was chosen before for this
	 * sender and account number (someone chose it before), else it waits for someone to choose; the
	 * AI's guess (PDFs) is only offered as the suggestion, never used by itself.
	 */
	async function stageEmailStatement(parsed, { filename, email, hint, guess = null, source = "module", uploadedBy = "module", document = null }) {
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
			source,
			mail: { messageId: email.messageId, from: email.from, subject: email.subject, sourceKey: key },
		});
	}

	/** Extracts and stores a bill or receipt from a document (a parsed email, PDF or picture); returns { outcome, bill_id }. */
	async function ingest(email, { source, ai, mail, kind = null }) {
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
		const x = await extractBill({ llm: ai.llm, readsPdf: ai.readsPdf, readsImages: ai.readsImages, email, pdfs: pdfs.slice(0, 3), images, accounts, examples: await pastVendors() });
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
				pdfs.length > 0 && !ai.readsPdf
					? "No amount found: it's probably in the PDF; reading PDFs needs Claude as Ledger's LLM connection for images and documents (Settings → LLM API)."
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
				x.summary,
				notes.join(" ") || null,
				source,
				email.messageId,
				email.from.slice(0, 300),
				email.subject.slice(0, 500),
				email.date,
				email.text.slice(0, 50_000),
			],
		);
		// The PDF or picture, in its own table (backups keep the bills table readable).
		if (doc) {
			await q(`INSERT INTO ${T("bill_documents")} (bill_id, file_name, content_type, content) VALUES ($1, $2, $3, $4)`, [
				rows[0].id,
				(doc.filename || "document.pdf").slice(0, 200),
				doc.contentType,
				doc.data,
			]);
		}
		return { outcome: (kind ?? x.kind) === "receipt" ? "receipt" : "bill", bill_id: rows[0].id };
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
			        EXISTS (SELECT 1 FROM ${T("transactions")} t WHERE t.bill_id = b.id AND t.status = 'new') AS matched
			   FROM ${T("bills")} b
			  WHERE b.status IN ('new', 'open') OR b.updated_at > now() - interval '3 days'`,
		);
		for (const b of rows) {
			const key = `bill-${b.id}`;
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
	async function onPosted(txId, code, entryId) {
		const { rows } = await q(
			`UPDATE ${T("bills")} b SET status = 'paid', paid_entry_id = $3, paid_at = now(), updated_at = now()
			   FROM ${T("transactions")} t
			  WHERE t.id = $1 AND t.bill_id = b.id AND COALESCE(b.ap_account, b.account_code) = $2 AND b.status IN ('new', 'open')
			  RETURNING b.id`,
			[txId, code, entryId],
		);
		for (const r of rows) await dash.complete(`bill-${r.id}`);
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
		return { bill: { ...bill, body_text: rows[0].body_text }, payments: await paymentOf(bill.id), lines: await linesOf(bill.id) };
	});

	ctx.route("GET", "/bills/:id/document", async (req) => {
		if (!/^\d+$/.test(req.params.id)) throw new ctx.HttpError(404, "no such bill");
		const { rows } = await q(`SELECT file_name, content_type, content FROM ${T("bill_documents")} WHERE bill_id = $1`, [req.params.id]);
		if (!rows[0]) throw new ctx.HttpError(404, "this bill has no document");
		return { name: rows[0].file_name, type: rows[0].content_type, data: rows[0].content.toString("base64") };
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
				if (!a || !a.is_active) throw bad(`no active account with code ${JSON.stringify(b.account_code)}`);
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
		if (current && (await linesOf(current.id)).length > 0 && "amount_cents" in f && String(f.amount_cents) !== String(current.amount_cents)) {
			throw new ctx.HttpError(409, "this is split into lines; change or remove the split first");
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
		await autoMatch();
		return ctx.response(201, await getBill(rows[0].id));
	});

	// POST /bills/upload {"filename": "invoice.pdf", "content_base64": "..."}: a PDF or a saved .eml file.
	ctx.route("POST", "/bills/upload", async (req) => {
		const b = req.body ?? {};
		const filename = typeof b.filename === "string" ? b.filename.trim().slice(0, 200) : "";
		if (typeof b.content_base64 !== "string" || b.content_base64 === "") throw bad("content_base64 is required");
		const r = await ingestDocument({ filename, data: Buffer.from(b.content_base64, "base64"), source: "upload" });
		if (r.outcome === "duplicate") throw new ctx.HttpError(409, `this looks like bill #${r.bill_id}, which is already here`);
		await autoMatch();
		return ctx.response(201, await getBill(r.bill_id));
	});

	/** A bill or receipt as a file (PDF or saved email): from an upload, or from another module (kind given). */
	async function ingestDocument({ filename, data, source, kind = null, from = "", note = "" }) {
		const ai = await h.ai();
		const mail = await billSettings();
		let email;
		if (/\.pdf$/i.test(filename) || data.subarray(0, 5).toString("latin1") === "%PDF-") {
			if (!ai.readsPdf) throw bad("reading PDFs needs Claude as Ledger's LLM connection for images and documents (Settings → LLM API); upload the bill's email (.eml) or a photo, or enter it by hand");
			email = { subject: note || filename, from, date: null, messageId: null, text: note, attachments: [{ filename: filename || "bill.pdf", contentType: "application/pdf", data }] };
		} else if (imageType(data)) {
			// A photo or scan of the bill or receipt.
			if (!ai.readsImages) throw bad("reading pictures needs an LLM connection for images (Settings → LLM API, e.g. Claude or a local vision model); enter it by hand instead");
			if (data.length > MAX_DOCUMENT_BYTES) throw bad(`the picture is larger than ${MAX_DOCUMENT_BYTES >> 20} MB; send a smaller one`);
			email = { subject: note || filename, from, date: null, messageId: null, text: note, attachments: [{ filename: filename || "receipt.jpg", contentType: imageType(data), data }] };
		} else {
			email = parseEmail(data);
			if (!email.subject && !email.text && email.attachments.length === 0) throw bad("this isn't a PDF, a picture or a saved email (.eml)");
		}
		return ingest(email, { source, ai, mail, kind });
	}

	/**
	 * A statement or transaction list from another module: CSV/OFX/QFX/QBO, or a PDF read by the AI.
	 * The account comes from meta.account_code, or what was chosen before for this module and account
	 * number, or waits to be chosen on the Statements tab. Returns stageStatement's result.
	 */
	async function ingestStatementFile({ filename, data, contentType, sender, meta = {}, note = "", by }) {
		const email = { subject: note || filename, from: `module:${sender}`, messageId: null, text: note, attachments: [{ filename, contentType, data }] };
		const accounts = await accountsByCode();
		const given = typeof meta.account_code === "string" && meta.account_code ? accounts.get(meta.account_code) : null;
		if (typeof meta.account_code === "string" && meta.account_code && !given?.is_active) throw bad(`account ${meta.account_code} doesn't exist or is inactive`);
		const isPdf = /\.pdf$/i.test(filename) || data.subarray(0, 5).toString("latin1") === "%PDF-";
		if (!isPdf) {
			let parsed;
			try {
				parsed = parseStatement(data.toString("utf8"), { filename, dateOrder: ["mdy", "dmy"].includes(meta.date_order) ? meta.date_order : "auto" });
			} catch (err) {
				if (err instanceof ParseError) throw bad(err.message);
				throw err;
			}
			if (given) return h.stageStatement(parsed, { document: { data, type: isPdf ? "application/pdf" : contentType || "text/csv" }, filename, account: given, flip: typeof meta.flip_signs === "boolean" ? meta.flip_signs : shouldFlip(given, parsed), uploadedBy: by, source: "module" });
			return stageEmailStatement(parsed, { document: { data, type: isPdf ? "application/pdf" : contentType || "text/csv" }, filename, email, hint: accountHint(data.toString("utf8"), note), source: "module", uploadedBy: by });
		}
		const ai = await h.ai();
		if (!ai.readsPdf) throw bad("reading PDF statements needs Claude as Ledger's LLM connection for images and documents (Settings → LLM API); send the CSV or OFX export instead");
		const bankish = (await ctx.ledger.listAccounts()).filter((a) => a.type === "asset" || a.type === "liability");
		const r = await extractPdfStatement({ llm: ai.llm, email, pdf: { filename, data }, accounts: bankish });
		if (r.transactions.length === 0) throw bad("no transactions found in this PDF");
		const parsed = { format: "pdf", transactions: r.transactions, warnings: [] };
		const staged = given
			? await h.stageStatement(parsed, { document: { data, type: isPdf ? "application/pdf" : contentType || "text/csv" }, filename, account: given, flip: false, uploadedBy: by, source: "module" })
			: await stageEmailStatement(parsed, { document: { data, type: isPdf ? "application/pdf" : contentType || "text/csv" }, filename, email, hint: r.account_hint || accountHint(note), guess: r.account_code, source: "module", uploadedBy: by });
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
		}
		await applyFields(bill.id, f, req.user.username);
		if (f.status === "ignored" || f.amount_cents !== undefined || f.account_code !== undefined) await unlink(bill.id);
		await autoMatch();
		return getBill(bill.id);
	});

	ctx.route("DELETE", "/bills/:id", async (req) => {
		const bill = await getBill(req.params.id);
		if (bill.journal_entry_id) throw new ctx.HttpError(409, "undo the approval before deleting this bill");
		if ((await paymentOf(bill.id)).some((t) => t.status === "posted")) throw new ctx.HttpError(409, "a posted payment refers to this bill; ignore it instead");
		await unlink(bill.id);
		await h.settleFile?.({ billId: bill.id }, "rejected", `deleted in ${ctx.name} by ${req.user.username}`, req.user.username);
		await q(`DELETE FROM ${T("bills")} WHERE id = $1`, [bill.id]);
		await dash.remove(`bill-${bill.id}`);
	});

	// Approve: the details are right. With a payable account set, also post the bill to payables.
	ctx.route("POST", "/bills/:id/approve", async (req) => {
		const bill = await getBill(req.params.id);
		if (!["new", "open"].includes(bill.status)) throw new ctx.HttpError(409, `this bill is ${bill.status}`);
		if (bill.amount_cents === null) throw bad("enter the amount first");
		if (!bill.account_code) throw bad("choose the account first");
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
			const date = bill.bill_date ?? bill.due_date ?? new Date().toISOString().slice(0, 10);
			const entry = await ctx.ledger.createJournalEntry(
				{
					entry_date: date,
					description: `${bill.vendor || "Bill"}${bill.invoice_number ? ` invoice ${bill.invoice_number}` : " bill"}`.slice(0, 500),
					reference: (bill.invoice_number ? `bill ${bill.invoice_number}` : `bill ${bill.id}`).slice(0, 100),
					lines: [
						...((await linesOf(bill.id)).length > 0
							? (await linesOf(bill.id)).map((l) => ({ account_code: l.account_code, debit_cents: l.amount_cents, credit_cents: 0n, memo: l.description.slice(0, 500) }))
							: [{ account_code: bill.account_code, debit_cents: bill.amount_cents, credit_cents: 0n, memo: bill.due_date ? `due ${bill.due_date}` : "" }]),
						{ account_code: ap.code, debit_cents: 0n, credit_cents: bill.amount_cents, memo: "" },
					],
					links: [billLink(bill)],
				},
				req.user,
			);
			await q(`UPDATE ${T("bills")} SET journal_entry_id = $2, ap_account = $3 WHERE id = $1`, [bill.id, entry.id, ap.code]);
		}
		await applyFields(bill.id, { status: bill.status === "new" ? "open" : bill.status, error: null }, req.user.username);
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
			await q(`UPDATE ${T("bills")} SET journal_entry_id = NULL, ap_account = NULL WHERE id = $1`, [bill.id]);
		}
		await applyFields(bill.id, { status: "new" }, req.user.username);
		await unlink(bill.id);
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
		await q(`UPDATE ${T("bills")} SET status = 'paid', paid_entry_id = $2, paid_at = now(), updated_by = $3, updated_at = now() WHERE id = $1`, [bill.id, e.id, user.username]);
		await ctx.ledger.linkJournalEntry(e.id, billLink(bill), user);
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
		await q(`UPDATE ${T("bills")} SET status = 'open', paid_entry_id = NULL, paid_at = NULL, updated_by = $2, updated_at = now() WHERE id = $1`, [bill.id, req.user.username]);
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
		const { rows } = await q(
			`SELECT f.content AS document, f.content_type AS document_type, b.body_text FROM ${T("bills")} b LEFT JOIN ${T("bill_documents")} f ON f.bill_id = b.id WHERE b.id = $1`,
			[bill.id],
		);
		const d = rows[0];
		const doc = { text: d.body_text || "" };
		if (d.document && d.document_type === "application/pdf" && ai.readsPdf) doc.pdf = d.document;
		else if (d.document && /^image\//.test(d.document_type ?? "") && ai.readsImages) doc.image = { data: d.document, contentType: d.document_type };
		return doc;
	}

	// GET /customers: customer names used on bills and receipts (the page adds the Sales module's).
	ctx.route("GET", "/customers", async () => {
		const { rows } = await q(
			`SELECT DISTINCT ON (lower(customer_name)) customer_name, customer_ref FROM ${T("bills")} WHERE customer_name <> '' ORDER BY lower(customer_name), updated_at DESC LIMIT 500`,
		);
		return { data: rows };
	});

	// POST /bills/:id/split-draft: the LLM reads the document and proposes lines (nothing is saved).
	ctx.route("POST", "/bills/:id/split-draft", async (req) => {
		const bill = await getBill(req.params.id);
		await assertSplittable(bill);
		const ai = await h.ai();
		const doc = await documentOf(bill, ai);
		if (!doc.pdf && !doc.image && !doc.text.trim()) {
			throw bad(bill.has_document ? "the LLM connection for images can't read this document (PDFs need Claude); enter the lines by hand" : "there's no document to read; enter the lines by hand");
		}
		const accounts = (await ctx.ledger.listAccounts()).filter((a) => a.currency === bill.currency && !["asset", "liability", "equity"].includes(a.type) && a.code !== bill.ap_account);
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
			if (!a || !a.is_active) throw bad(`line ${i + 1}: choose an active account`);
			if (a.currency !== bill.currency) throw bad(`line ${i + 1}: account ${a.code} is in ${a.currency}, the ${bill.kind} in ${bill.currency}`);
			if (typeof (l.description ?? "") !== "string") throw bad(`line ${i + 1}: description must be text`);
			return { description: String(l.description ?? "").trim().slice(0, 200), amount, account_code: a.code };
		});
		const sum = lines.reduce((t, l) => t + l.amount, 0n);
		if (sum !== BigInt(bill.amount_cents)) throw bad(`the lines add up to ${formatCents(sum)}, not the ${bill.kind}'s ${formatCents(BigInt(bill.amount_cents))}`);
		await q(`DELETE FROM ${T("bill_lines")} WHERE bill_id = $1`, [bill.id]);
		await q(
			`INSERT INTO ${T("bill_lines")} (bill_id, line_no, description, amount_cents, account_code)
			 SELECT $1, u.n, u.d, u.a, u.c FROM unnest($2::int[], $3::text[], $4::bigint[], $5::text[]) AS u(n, d, a, c)`,
			[bill.id, lines.map((_, i) => i + 1), lines.map((l) => l.description), lines.map((l) => l.amount.toString()), lines.map((l) => l.account_code)],
		);
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
		await q(`DELETE FROM ${T("bill_lines")} WHERE bill_id = $1`, [bill.id]);
	});

	/**
	 * What a statement says is owed, read by the LLM, as a bill draft (nothing is saved; the user
	 * edits it and creates the bill with POST /bills { ..., statement_id }).
	 */
	async function statementBillDraft(statement) {
		const ai = await h.ai();
		const { rows } = await q(`SELECT content AS document, content_type AS document_type FROM ${T("statement_files")} WHERE statement_id = $1`, [statement.id]);
		const d = rows[0] ?? {};
		const doc = {};
		if (d.document && d.document_type === "application/pdf") {
			if (!ai.readsPdf) throw bad("reading this PDF statement needs Claude as Ledger's LLM connection for images and documents (Settings → LLM API); enter the bill by hand");
			doc.pdf = d.document;
		} else if (d.document) doc.text = d.document.toString("utf8");
		const { rows: sums } = await q(
			`SELECT count(*)::int AS n, min(tx_date)::text AS first, max(tx_date)::text AS last,
			        COALESCE(sum(amount_cents) FILTER (WHERE amount_cents < 0), 0) AS out_cents, COALESCE(sum(amount_cents) FILTER (WHERE amount_cents > 0), 0) AS in_cents
			   FROM ${T("transactions")} WHERE statement_id = $1`,
			[statement.id],
		);
		const account = (await accountsByCode()).get(statement.account_code);
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

	return { autoMatch, targetOf, onPosted, ingestDocument, ingestStatementFile, linkFor, getBill, billLink, matchBillTx, linkBillEntry, linesOf, statementBillDraft, syncBillTodos };
}

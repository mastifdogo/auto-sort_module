// Files other modules hand Auto sort through Ledger (ctx.files, Ledger ≥ 0.11.0): statements and
// transaction lists are staged on the Statements tab, bills and receipts go to their tabs. Nothing
// is posted; each file is marked done (with what it became) or rejected (with why) for its sender.
// A file the AI read (bills, receipts, PDF statements) stays "accepted" until a person approves what
// it became: approving the bill, posting from the statement, or Approve on the Import tab.

const PENDING_SWEEP_MS = 5 * 60_000;

export function registerReceivedFiles(ctx, { q, T, bills }) {
	const busy = new Set();
	let queue = Promise.resolve();

	/** Works through one file; runs in the organization the file was sent in. */
	async function processFile(id) {
		const org = (await ctx.orgs.current()).id;
		const key = `${org}:${id}`;
		if (busy.has(key)) return;
		busy.add(key);
		try {
			const { rows: seen } = await q(`SELECT 1 FROM ${T("received_files")} WHERE file_id = $1`, [id]);
			if (seen.length > 0) return;
			const file = await ctx.files.get(id);
			if (file.status !== "new" && file.status !== "accepted") return;
			await ctx.files.update(file.id, { status: "accepted", result: "" });
			const by = String(file.sent_by || file.sender).slice(0, 100);
			const data = Buffer.from(file.data);
			const meta = file.meta && typeof file.meta === "object" && !Array.isArray(file.meta) ? file.meta : {};
			const note = String(file.note ?? "");
			let outcome;
			let statementId = null;
			let billId = null;
			let message;
			let pending = false;
			try {
				if (file.kind === "statement" || file.kind === "transaction") {
					const r = await bills.ingestStatementFile({ filename: file.filename, data, contentType: file.content_type, sender: file.sender, meta, note, by });
					pending = r.ai === true;
					if (r.id) {
						outcome = "statement";
						statementId = r.id;
						message = `${r.transactions} transaction${r.transactions === 1 ? "" : "s"} staged for review in ${ctx.name}${r.duplicates ? ` (${r.duplicates} already there)` : ""}`;
					} else {
						outcome = "duplicate";
						message = `all ${r.duplicates} transactions were already in ${ctx.name}`;
					}
				} else {
					const r = await bills.ingestDocument({ filename: file.filename, data, source: "module", kind: file.kind, from: `module:${file.sender}`, note });
					pending = true; // read by the AI
					billId = r.bill_id ?? null;
					if (r.outcome === "duplicate") {
						outcome = "duplicate";
						message = `already in ${ctx.name} as ${file.kind} #${r.bill_id}`;
					} else {
						outcome = r.outcome === "receipt" ? "receipt" : "bill";
						message = `added to ${ctx.name}'s ${outcome === "receipt" ? "Receipts" : "Bills"} for review`;
						await bills.autoMatch();
					}
				}
				// The AI's reading is only a suggestion until someone approves it.
				await ctx.files.update(file.id, pending ? { status: "accepted", result: `${message}; waiting for review` } : { status: "done", result: message });
			} catch (err) {
				outcome = "rejected";
				message = String(err?.message || err).slice(0, 500);
				await ctx.files.update(file.id, { status: "rejected", result: message });
				ctx.log.warn("received file rejected", { file: String(file.id), sender: file.sender, kind: file.kind, err: message });
			}
			await q(
				`INSERT INTO ${T("received_files")} (file_id, outcome, statement_id, bill_id, message, pending) VALUES ($1, $2, $3, $4, $5, $6)
				 ON CONFLICT (file_id) DO UPDATE SET outcome = EXCLUDED.outcome, statement_id = EXCLUDED.statement_id, bill_id = EXCLUDED.bill_id,
				                                     message = EXCLUDED.message, pending = EXCLUDED.pending, settled_by = NULL, created_at = now()`,
				[file.id, outcome, statementId, billId, message, pending && outcome !== "rejected"],
			);
			ctx.log.info("received file", { file: String(file.id), sender: file.sender, kind: file.kind, outcome });
		} finally {
			busy.delete(key);
		}
	}

	// One file at a time. Each step keeps the organization it was queued in.
	const enqueue = (id) => {
		queue = queue.then(() => processFile(id)).catch((err) => ctx.log.error("received file failed", { file: String(id), err: String(err?.message || err) }));
	};

	ctx.files.onReceive((f) => enqueue(f.id));

	/** Files that arrived while Ledger was restarting (or this module was off), in every organization. */
	const sweep = () =>
		ctx.orgs
			.forEach(async () => {
				for (const status of ["new", "accepted"]) for (const f of await ctx.files.inbox({ status, limit: 100 })) enqueue(f.id);
			})
			.catch((err) => ctx.log.error("received files sweep", { err: String(err?.message || err) }));
	sweep();
	const timer = setInterval(sweep, PENDING_SWEEP_MS);
	timer.unref?.();

	/** A file sent to this module (404 for anything else). */
	async function receivedFile(id) {
		if (!/^\d+$/.test(id)) throw new ctx.HttpError(404, "no such file");
		const file = await ctx.files.get(id).catch(() => null);
		if (!file || file.recipient !== ctx.id) throw new ctx.HttpError(404, "no such file");
		return file;
	}

	// GET /files?limit=50: files other modules sent, newest first, with what each became.
	ctx.route("GET", "/files", async (req) => {
		const limit = Math.min(Math.max(Number.parseInt(req.query.get("limit") ?? "50", 10) || 50, 1), 200);
		const files = await ctx.files.inbox({ limit });
		if (files.length === 0) return { data: [] };
		const { rows } = await q(
			`SELECT r.file_id, r.outcome, r.pending, r.settled_by, r.statement_id, r.bill_id, b.kind AS bill_kind, b.vendor AS bill_vendor, s.filename AS statement_filename
			   FROM ${T("received_files")} r LEFT JOIN ${T("bills")} b ON b.id = r.bill_id LEFT JOIN ${T("statements")} s ON s.id = r.statement_id
			  WHERE r.file_id = ANY($1::bigint[])`,
			[files.map((f) => String(f.id))],
		);
		const local = new Map(rows.map((r) => [String(r.file_id), r]));
		return {
			data: files.map((f) => {
				const r = local.get(String(f.id));
				return {
					id: f.id,
					sender: f.sender,
					kind: f.kind,
					filename: f.filename,
					size_bytes: f.size_bytes,
					note: f.note,
					status: f.status,
					result: f.result,
					sent_by: f.sent_by,
					created_at: f.created_at,
					outcome: r?.outcome ?? null,
					pending: r?.pending ?? false,
					settled_by: r?.settled_by ?? null,
					statement_id: r?.statement_id ?? null,
					bill_id: r?.bill_id ?? null,
					bill_kind: r?.bill_kind ?? null,
					bill_vendor: r?.bill_vendor ?? null,
				};
			}),
		};
	});

	/**
	 * A person acted on what a file became: mark the files waiting for review done or rejected for
	 * their senders. target: { billId } or { statementId }.
	 */
	async function settle(target, status, result, by) {
		const { rows } = await q(
			`UPDATE ${T("received_files")} SET pending = false, settled_by = $3
			  WHERE pending AND (bill_id = $1 OR statement_id = $2) RETURNING file_id, message`,
			[target.billId ?? null, target.statementId ?? null, String(by).slice(0, 100)],
		);
		for (const r of rows) {
			await ctx.files
				.update(r.file_id, { status, result: `${r.message}; ${result}`.slice(0, 2000) })
				.catch((err) => ctx.log.warn("received file not updated", { file: String(r.file_id), err: String(err?.message || err) }));
		}
		return rows.length;
	}

	// POST /files/:id/approve and /reject: a person reviewed what the AI made of a file.
	for (const [action, status] of [["approve", "done"], ["reject", "rejected"]]) {
		ctx.route("POST", `/files/:id/${action}`, async (req) => {
			const file = await receivedFile(req.params.id);
			const { rows } = await q(
				`UPDATE ${T("received_files")} SET pending = false, settled_by = $2 WHERE file_id = $1 AND pending RETURNING message`,
				[file.id, req.user.username],
			);
			if (rows.length === 0) throw new ctx.HttpError(409, "this file isn't waiting for review");
			const result = `${rows[0].message}; ${action === "approve" ? "approved" : "rejected"} by ${req.user.username}`;
			await ctx.files.update(file.id, { status, result: result.slice(0, 2000) });
			return { id: file.id, status, result };
		});
	}

	// POST /files/:id/retry: try a rejected file again (e.g. after setting up the AI).
	ctx.route("POST", "/files/:id/retry", async (req) => {
		const file = await receivedFile(req.params.id);
		if (file.status !== "rejected") throw new ctx.HttpError(409, `this file is ${file.status}, not rejected`);
		await q(`DELETE FROM ${T("received_files")} WHERE file_id = $1`, [file.id]);
		await ctx.files.update(file.id, { status: "new", result: "" });
		await processFile(file.id);
		const { rows } = await q(`SELECT outcome, statement_id, bill_id, message FROM ${T("received_files")} WHERE file_id = $1`, [file.id]);
		return rows[0] ?? { outcome: null };
	});

	// DELETE /files/:id: remove a received file (what it became stays).
	ctx.route("DELETE", "/files/:id", async (req) => {
		const file = await receivedFile(req.params.id);
		await ctx.files.remove(file.id);
		await q(`DELETE FROM ${T("received_files")} WHERE file_id = $1`, [file.id]);
	});

	return { settle };
}

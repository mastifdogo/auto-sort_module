// Files the module keeps. PDFs and scans (bills, receipts, PDF statements) are filed in Ledger's
// Documents (ctx.documents, Ledger 0.19.0), the one PDF store shared with every module; other files
// (CSV and OFX statements) are in the module's storage (ctx.storage). bill_documents and
// statement_files say what each file is and where it is.

const EXT = {
	"application/pdf": ".pdf",
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
	"text/csv": ".csv",
	"text/plain": ".txt",
	"application/x-ofx": ".ofx",
	"message/rfc822": ".eml",
};
const KNOWN_EXT = /\.(pdf|png|jpe?g|gif|webp|heic|tiff?|csv|txt|json|xml|eml|zip|ofx|qfx|xlsx|docx)$/i;

/** A file name Ledger's storage accepts (letters, digits, spaces, . _ - ( )), with an extension for its type. */
export function storageName(name, contentType) {
	let n = String(name ?? "")
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^\w .()-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[^A-Za-z0-9]+/, "")
		.trim()
		.slice(0, 100)
		.trim();
	const ext = EXT[contentType] ?? "";
	if (!n || n === "." || n === "..") n = "file";
	if (!KNOWN_EXT.test(n) && ext) n += ext;
	return n;
}

export const billFilePath = (billId, name, type) => `bills/${billId}/${storageName(name, type)}`;
export const statementFilePath = (statementId, name, type) => `statements/${statementId}/${storageName(name, type)}`;

/** What Ledger's Documents store takes (checked by content there too): PDFs, PNG and JPEG scans. */
const STORE_TYPES = new Set(["application/pdf", "image/png", "image/jpeg"]);
export const goesToDocuments = (contentType) => STORE_TYPES.has(contentType);

/** The id in Ledger's "already here as … (document 12)" answer to a file it has. */
export function existingDocumentId(err) {
	if (err?.status !== 409) return null;
	const m = /\(document (\d+)\)/.exec(String(err?.message ?? ""));
	return m ? Number(m[1]) : null;
}

/**
 * h: { q, T }. Reads and writes the module's files. PDFs and scans are filed in Ledger's Documents
 * (ctx.documents, Ledger 0.19.0) and only their id is kept; other files (CSV and OFX statements)
 * go to the module's storage. Older files are read from where they are until they're moved.
 */
export function moduleFiles(ctx, { q, T }) {
	/** Files a PDF or scan in Documents; a file already there is used as it is. Returns the document id. */
	async function fileDocument(doc, user) {
		try {
			return (await ctx.documents.add({ origin: "imported", ...doc }, user)).id;
		} catch (err) {
			const id = existingDocumentId(err);
			if (id === null) throw err;
			return id;
		}
	}

	const TABLES = { bill: ["bill_documents", "bill_id"], statement: ["statement_files", "statement_id"] };

	async function save(which, id, { filename, contentType, data }, docMeta, user) {
		const [table, key] = TABLES[which];
		const name = String(filename || (which === "bill" ? "document" : "statement")).slice(0, 200);
		let documentId = null;
		let storagePath = null;
		if (goesToDocuments(contentType)) documentId = await fileDocument({ ...docMeta, filename: storageName(name, contentType), data }, user);
		else storagePath = (await ctx.storage.put(which === "bill" ? billFilePath(id, name, contentType) : statementFilePath(id, name, contentType), data)).path;
		await q(
			`INSERT INTO ${T(table)} (${key}, file_name, content_type, size_bytes, storage_path, document_id) VALUES ($1, $2, $3, $4, $5, $6)
			 ON CONFLICT (${key}) DO UPDATE SET file_name = EXCLUDED.file_name, content_type = EXCLUDED.content_type, size_bytes = EXCLUDED.size_bytes,
			                                    storage_path = EXCLUDED.storage_path, document_id = EXCLUDED.document_id, content = NULL`,
			[id, name, contentType, data.length, storagePath, documentId],
		);
		return { document_id: documentId, storage_path: storagePath };
	}

	/** Saves a bill's or receipt's document. meta: { kind: "bill" | "receipt", title?, doc_date?, entity_id? }. */
	const saveBillFile = (billId, file, meta = {}, user) =>
		save("bill", billId, file, { kind: meta.kind === "receipt" ? "receipt" : "invoice", title: meta.title || undefined, doc_date: meta.doc_date || undefined, entity_id: meta.entity_id || undefined }, user);

	/** Saves a statement's file. meta: { account_code? } (the statement's account, when a person chose it). */
	const saveStatementFile = (statementId, file, meta = {}, user) =>
		save("statement", statementId, file, { kind: "statement", account_code: meta.account_code || undefined }, user);

	/** A file's row and bytes ({ name, type, data, url }), or null (also when its file is gone, e.g. after a restore). */
	async function read(which, id) {
		const [table, key] = TABLES[which];
		const { rows } = await q(`SELECT file_name, content_type, content, storage_path, document_id FROM ${T(table)} WHERE ${key} = $1`, [String(id)]);
		const r = rows[0];
		if (!r) return null;
		if (r.document_id) {
			const data = await ctx.documents.read(r.document_id).catch(() => null);
			return data ? { name: r.file_name, type: r.content_type, data, url: ctx.documents.url(r.document_id) } : null;
		}
		if (r.storage_path) {
			const got = await ctx.storage.get(r.storage_path);
			return got ? { name: r.file_name, type: r.content_type, data: got.data, url: ctx.storage.url(r.storage_path) } : null;
		}
		return r.content ? { name: r.file_name, type: r.content_type, data: r.content, url: null } : null;
	}
	const readBillFile = (billId) => read("bill", billId);
	const readStatementFile = (statementId) => read("statement", statementId);

	/** Where a browser opens the file, or null when there's none (or it's gone). */
	async function urlOf(which, id) {
		const [table, key] = TABLES[which];
		const { rows } = await q(`SELECT storage_path, document_id FROM ${T(table)} WHERE ${key} = $1`, [String(id)]);
		const r = rows[0];
		if (r?.document_id) return (await ctx.documents.get(r.document_id).catch(() => null)) ? ctx.documents.url(r.document_id) : null;
		if (r?.storage_path) return (await ctx.storage.stat(r.storage_path).catch(() => null)) ? ctx.storage.url(r.storage_path) : null;
		return null;
	}

	/** Changes a filed document's details (a person approved or edited the bill). Best effort. */
	async function updateBillDocument(billId, change) {
		const { rows } = await q(`SELECT document_id FROM ${T("bill_documents")} WHERE bill_id = $1`, [String(billId)]);
		if (!rows[0]?.document_id) return;
		const doc = await ctx.documents.get(rows[0].document_id).catch(() => null);
		// Only documents this module filed: others belong to the people who keep them.
		if (!doc || doc.source !== ctx.id) return;
		await ctx.documents.update(doc.id, change).catch((err) => ctx.log.warn("document not updated", { document: String(doc.id), err: String(err?.message || err) }));
	}

	/** Removes a file with its bill or statement: from storage, or from Documents when this module filed it and nothing else uses it. */
	async function remove(which, id) {
		const [table, key] = TABLES[which];
		const { rows } = await q(`SELECT storage_path, document_id FROM ${T(table)} WHERE ${key} = $1`, [String(id)]);
		const r = rows[0];
		if (r?.storage_path) await ctx.storage.remove(r.storage_path).catch(() => false);
		if (r?.document_id) {
			const { rows: used } = await q(
				`SELECT (SELECT count(*) FROM ${T("bill_documents")} WHERE document_id = $1) + (SELECT count(*) FROM ${T("statement_files")} WHERE document_id = $1) AS n`,
				[r.document_id],
			);
			// Ledger refuses (403) documents a person or another module added: those stay.
			if (Number(used[0].n) <= 1) await ctx.documents.remove(r.document_id).catch(() => {});
		}
	}
	const removeBillFile = (billId) => remove("bill", billId);
	const removeStatementFile = (statementId) => remove("statement", statementId);

	/** Moves files kept in the database before 0.8.0 to the module's storage, a few at a time. Returns how many moved. */
	async function moveOldFiles() {
		let moved = 0;
		for (const [table, key, pathOf] of [
			["bill_documents", "bill_id", billFilePath],
			["statement_files", "statement_id", statementFilePath],
		]) {
			for (;;) {
				const { rows } = await q(`SELECT ${key} AS id, file_name, content_type, content FROM ${T(table)} WHERE content IS NOT NULL AND storage_path IS NULL AND document_id IS NULL LIMIT 10`);
				if (rows.length === 0) break;
				for (const r of rows) {
					const f = await ctx.storage.put(pathOf(r.id, r.file_name || "file", r.content_type), r.content);
					await q(`UPDATE ${T(table)} SET storage_path = $2, size_bytes = $3, content = NULL WHERE ${key} = $1`, [r.id, f.path, f.size]);
					moved++;
				}
			}
		}
		return moved;
	}

	const PENDING = (table) => `FROM ${T(table)} WHERE document_id IS NULL AND storage_path IS NOT NULL AND content_type IN ('application/pdf', 'image/png', 'image/jpeg')`;

	/** PDFs and scans still in the module's storage (from before 0.10.0), waiting to be filed in Documents. */
	async function pendingForDocuments() {
		const { rows } = await q(`SELECT (SELECT count(*) ${PENDING("bill_documents")}) + (SELECT count(*) ${PENDING("statement_files")}) AS n`);
		return Number(rows[0].n);
	}

	/**
	 * Files those in Ledger's Documents and takes them out of the module's storage. Only on a
	 * person's request (it moves their files). Returns { moved, missing }.
	 */
	async function moveToDocuments(user) {
		let moved = 0;
		let missing = 0;
		const { rows: billRows } = await q(
			`SELECT d.bill_id AS id, d.file_name, d.content_type, d.storage_path, b.kind, b.vendor, b.invoice_number, COALESCE(b.bill_date, b.due_date)::text AS doc_date, b.vendor_entity_id
			   FROM ${T("bill_documents")} d JOIN ${T("bills")} b ON b.id = d.bill_id
			  WHERE d.document_id IS NULL AND d.storage_path IS NOT NULL AND d.content_type IN ('application/pdf', 'image/png', 'image/jpeg') ORDER BY d.bill_id`,
		);
		const { rows: stRows } = await q(
			`SELECT f.statement_id AS id, f.file_name, f.content_type, f.storage_path, s.account_code
			   FROM ${T("statement_files")} f JOIN ${T("statements")} s ON s.id = f.statement_id
			  WHERE f.document_id IS NULL AND f.storage_path IS NOT NULL AND f.content_type IN ('application/pdf', 'image/png', 'image/jpeg') ORDER BY f.statement_id`,
		);
		const one = async (table, key, r, meta) => {
			const got = await ctx.storage.get(r.storage_path).catch(() => null);
			if (!got) { missing++; return; }
			const id = await fileDocument({ ...meta, filename: storageName(r.file_name, r.content_type), data: got.data }, user);
			await q(`UPDATE ${T(table)} SET document_id = $2, storage_path = NULL WHERE ${key} = $1`, [r.id, id]);
			await ctx.storage.remove(r.storage_path).catch(() => false);
			moved++;
		};
		for (const r of billRows) {
			await one("bill_documents", "bill_id", r, {
				kind: r.kind === "receipt" ? "receipt" : "invoice",
				title: `${r.vendor || "Bill"}${r.invoice_number ? ` ${r.invoice_number}` : ""}`.slice(0, 200),
				doc_date: r.doc_date || undefined,
				entity_id: r.vendor_entity_id ? Number(r.vendor_entity_id) : undefined,
			});
		}
		for (const r of stRows) await one("statement_files", "statement_id", r, { kind: "statement", account_code: r.account_code || undefined });
		return { moved, missing };
	}

	return {
		saveBillFile, saveStatementFile, readBillFile, readStatementFile, removeBillFile, removeStatementFile, moveOldFiles,
		billFileUrl: (id) => urlOf("bill", id), updateBillDocument, pendingForDocuments, moveToDocuments,
	};
}

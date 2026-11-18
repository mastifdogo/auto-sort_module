// Files. The module keeps none of its own (Ledger 0.27.0): every file it receives or handles, of
// any type (PDFs, scans, CSV, OFX and QFX statements, saved emails), is one of Ledger's Documents
// (ctx.documents), the one file store shared with every module. bill_documents and statement_files
// say which document a bill's or a statement's file is; the inbox (lib/inbox.mjs) keeps the id too.
//
// Files saved before 0.17.0 that are still in the module's old storage (ctx.storage: CSV and OFX
// statements, pictures other than PNG and JPEG) are filed in Documents when Ledger starts
// (moveStorageToDocuments); until a file has moved it is read from where it is.

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
const KNOWN_EXT = /\.(pdf|png|jpe?g|gif|webp|heic|tiff?|csv|tsv|txt|json|xml|eml|zip|ofx|qfx|qbo|xlsx?|docx)$/i;

/** A plain file name (no folders or control characters, at most 104 characters) with an extension for its type. */
export function fileName(name, contentType) {
	let n = String(name ?? "")
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^\w .()-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[^A-Za-z0-9]+/, "")
		.trim()
		.slice(0, 100)
		.trim();
	const ext = EXT[String(contentType ?? "").split(";")[0].trim().toLowerCase()] ?? "";
	if (!n || n === "." || n === "..") n = "file";
	if (!KNOWN_EXT.test(n) && ext) n += ext;
	return n;
}

/** The document that already holds a file Ledger refused as a duplicate (409), or null. */
export function existingDocumentId(err) {
	if (err?.status !== 409) return null;
	if (Number.isSafeInteger(Number(err.document_id)) && Number(err.document_id) > 0) return Number(err.document_id);
	const m = /\(document (\d+)\)/.exec(String(err?.message ?? ""));
	return m ? Number(m[1]) : null;
}

/** Ledger's "not found": an HttpError with status 404, or its NotFoundError (which carries no status). */
export const notFound404 = (err) => err?.status === 404 || err?.constructor?.name === "NotFoundError";

/** The kind a document is filed as in Ledger's Documents, for what the module calls it. */
export const DOCUMENT_KIND = { statement: "statement", transaction: "statement", bill: "invoice", invoice: "invoice", receipt: "receipt", other: "other" };

/**
 * h: { q, T }. Files a document for a bill or a statement and keeps its id; reads, opens and
 * removes it; and moves what an older version left in the module's storage into Documents.
 */
export function moduleFiles(ctx, { q, T }) {
	/**
	 * Files bytes in Ledger's Documents → { id, added }. A file the store already has is used as
	 * it is (added: false), never stored twice. opts.announce: false for a file that is only being
	 * moved (it was handled long ago): other modules aren't told a new document arrived.
	 */
	async function fileDocument(doc, user, opts = {}) {
		const input = { origin: "imported", ...doc };
		const how = opts.announce === false ? { announce: false } : undefined;
		if (typeof ctx.documents.ensure === "function") {
			const r = await ctx.documents.ensure(input, user, how);
			return { id: Number(r.document.id), added: r.added === true };
		}
		try {
			return { id: Number((await ctx.documents.add(input, user, how)).id), added: true };
		} catch (err) {
			const id = existingDocumentId(err);
			if (id === null) throw err;
			return { id, added: false };
		}
	}

	const TABLES = { bill: ["bill_documents", "bill_id"], statement: ["statement_files", "statement_id"] };

	/**
	 * Records the file of a bill or statement. file: { filename, contentType, data } to file now, or
	 * { filename, contentType, size, documentId } for a file that is a document already (from the
	 * inbox, or handed over by another module).
	 */
	async function save(which, id, file, docMeta, user) {
		const [table, key] = TABLES[which];
		const name = String(file.filename || (which === "bill" ? "document" : "statement")).slice(0, 200);
		let documentId = file.documentId ?? null;
		let added = false;
		if (documentId === null) {
			({ id: documentId, added } = await fileDocument({ ...docMeta, filename: fileName(name, file.contentType), data: file.data, content_type: file.contentType || undefined }, user));
		}
		await q(
			`INSERT INTO ${T(table)} (${key}, file_name, content_type, size_bytes, storage_path, document_id) VALUES ($1, $2, $3, $4, NULL, $5)
			 ON CONFLICT (${key}) DO UPDATE SET file_name = EXCLUDED.file_name, content_type = EXCLUDED.content_type, size_bytes = EXCLUDED.size_bytes,
			                                    storage_path = NULL, document_id = EXCLUDED.document_id`,
			[id, name, String(file.contentType ?? ""), file.data ? file.data.length : Number(file.size ?? 0), String(documentId)],
		);
		return { document_id: documentId, added };
	}

	/** Saves a bill's or receipt's document. meta: { kind: "bill" | "receipt", title?, doc_date?, entity_id? }. */
	const saveBillFile = (billId, file, meta = {}, user) =>
		save("bill", billId, file, { kind: meta.kind === "receipt" ? "receipt" : "invoice", title: meta.title || undefined, doc_date: meta.doc_date || undefined, entity_id: meta.entity_id || undefined }, user);

	/** Saves a statement's file. meta: { account_code? } (the statement's account, when a person chose it). */
	const saveStatementFile = (statementId, file, meta = {}, user) =>
		save("statement", statementId, file, { kind: "statement", account_code: meta.account_code || undefined }, user);

	/** The document a bill's or statement's file is, or null (none, or not moved out of the old storage yet). */
	async function documentIdOf(which, id) {
		const [table, key] = TABLES[which];
		const { rows } = await q(`SELECT document_id FROM ${T(table)} WHERE ${key} = $1`, [String(id)]);
		return rows[0]?.document_id == null ? null : Number(rows[0].document_id);
	}

	/** A file's row and bytes ({ name, type, data, url, document_id }), or null (also when its file is gone, e.g. after a restore). */
	async function read(which, id) {
		const [table, key] = TABLES[which];
		const { rows } = await q(`SELECT file_name, content_type, storage_path, document_id FROM ${T(table)} WHERE ${key} = $1`, [String(id)]);
		const r = rows[0];
		if (!r) return null;
		if (r.document_id != null) {
			const data = await ctx.documents.read(r.document_id).catch(() => null);
			return data ? { name: r.file_name, type: r.content_type, data, url: ctx.documents.url(r.document_id), document_id: Number(r.document_id) } : null;
		}
		if (r.storage_path && ctx.storage) {
			const got = await ctx.storage.get(r.storage_path).catch(() => null);
			return got ? { name: r.file_name, type: r.content_type, data: got.data, url: ctx.storage.url(r.storage_path), document_id: null } : null;
		}
		return null;
	}
	const readBillFile = (billId) => read("bill", billId);
	const readStatementFile = (statementId) => read("statement", statementId);

	/** Where a browser opens the file, or null when there's none (or it's gone). */
	async function urlOf(which, id) {
		const [table, key] = TABLES[which];
		const { rows } = await q(`SELECT storage_path, document_id FROM ${T(table)} WHERE ${key} = $1`, [String(id)]);
		const r = rows[0];
		if (r?.document_id != null) return (await ctx.documents.get(r.document_id).catch(() => null)) ? ctx.documents.url(r.document_id) : null;
		if (r?.storage_path && ctx.storage) return (await ctx.storage.stat(r.storage_path).catch(() => null)) ? ctx.storage.url(r.storage_path) : null;
		return null;
	}

	/** Changes a filed document's details (a person approved or edited the bill, or chose a statement's account). Best effort. */
	async function updateDocument(documentId, change, { onlyOwn = true } = {}) {
		if (documentId == null) return;
		const doc = await ctx.documents.get(documentId).catch(() => null);
		// Details a person didn't choose here are only written on documents this module filed.
		if (!doc || (onlyOwn && doc.source !== ctx.id)) return;
		await ctx.documents.update(doc.id, change).catch((err) => ctx.log.warn("document not updated", { document: String(doc.id), err: String(err?.message || err) }));
	}
	const updateBillDocument = async (billId, change) => updateDocument(await documentIdOf("bill", billId), change);

	/** How many of the module's records use a document (bills, statements, inbox files). */
	async function usesOf(documentId) {
		const { rows } = await q(
			`SELECT (SELECT count(*) FROM ${T("bill_documents")} WHERE document_id = $1)
			      + (SELECT count(*) FROM ${T("statement_files")} WHERE document_id = $1)
			      + (SELECT count(*) FROM ${T("inbox_files")} WHERE document_id = $1) AS n`,
			[String(documentId)],
		);
		return Number(rows[0]?.n ?? 0);
	}

	/**
	 * Removes a document this module filed, when none of its records uses it any more. Ledger
	 * refuses (403) documents a person or another module added: those stay.
	 */
	async function removeDocumentIfUnused(documentId, { uses = 0 } = {}) {
		if (documentId == null) return false;
		if ((await usesOf(documentId)) > uses) return false;
		try {
			await ctx.documents.remove(documentId);
			return true;
		} catch (err) {
			if (!notFound404(err) && err?.status !== 403) ctx.log.warn("document not removed", { document: String(documentId), err: String(err?.message || err) });
			return false;
		}
	}

	/** Removes a file with its bill or statement: its document goes when this module filed it and nothing else here uses it. */
	async function remove(which, id) {
		const [table, key] = TABLES[which];
		const { rows } = await q(`SELECT storage_path, document_id FROM ${T(table)} WHERE ${key} = $1`, [String(id)]);
		const r = rows[0];
		if (r?.storage_path && ctx.storage) await ctx.storage.remove(r.storage_path).catch(() => false);
		// This row still counts as one use.
		if (r?.document_id != null) await removeDocumentIfUnused(r.document_id, { uses: 1 });
	}
	const removeBillFile = (billId) => remove("bill", billId);
	const removeStatementFile = (statementId) => remove("statement", statementId);

	// -----------------------------------------------------------------------
	// Out of the module's old storage, into Documents (once, at startup; safe to run again)
	// -----------------------------------------------------------------------

	const IN_STORAGE = (table) => `FROM ${T(table)} WHERE document_id IS NULL AND storage_path IS NOT NULL`;

	/** Files still in the module's old storage, waiting to be filed in Documents. */
	async function pendingInStorage() {
		const { rows } = await q(`SELECT (SELECT count(*) ${IN_STORAGE("bill_documents")}) + (SELECT count(*) ${IN_STORAGE("statement_files")}) AS n`);
		return Number(rows[0]?.n ?? 0);
	}

	/**
	 * Files every bill's and statement's file that is still in the module's old storage in Ledger's
	 * Documents, keeps the document's id and takes the file out of storage. A few at a time; a file
	 * that can't be found stays as it is (and is counted). Returns { moved, missing }.
	 */
	async function moveStorageToDocuments(user) {
		let moved = 0;
		const missing = new Set();
		if (!ctx.storage || typeof ctx.storage.get !== "function") return { moved, missing: 0 };
		const sources = [
			[
				"bill_documents",
				"bill_id",
				`SELECT d.bill_id AS id, d.file_name, d.content_type, d.storage_path, b.kind, b.vendor, b.invoice_number, COALESCE(b.bill_date, b.due_date)::text AS doc_date, b.vendor_entity_id
				   FROM ${T("bill_documents")} d JOIN ${T("bills")} b ON b.id = d.bill_id
				  WHERE d.document_id IS NULL AND d.storage_path IS NOT NULL AND NOT (d.bill_id = ANY($1::bigint[])) ORDER BY d.bill_id LIMIT 10`,
				(r) => ({
					kind: r.kind === "receipt" ? "receipt" : "invoice",
					title: `${r.vendor || "Bill"}${r.invoice_number ? ` ${r.invoice_number}` : ""}`.slice(0, 200),
					doc_date: r.doc_date || undefined,
					entity_id: r.vendor_entity_id ? Number(r.vendor_entity_id) : undefined,
				}),
			],
			[
				"statement_files",
				"statement_id",
				`SELECT f.statement_id AS id, f.file_name, f.content_type, f.storage_path, s.account_code
				   FROM ${T("statement_files")} f JOIN ${T("statements")} s ON s.id = f.statement_id
				  WHERE f.document_id IS NULL AND f.storage_path IS NOT NULL AND NOT (f.statement_id = ANY($1::bigint[])) ORDER BY f.statement_id LIMIT 10`,
				(r) => ({ kind: "statement", account_code: r.account_code || undefined }),
			],
		];
		for (const [table, key, sql, metaOf] of sources) {
			const skip = [];
			for (;;) {
				const { rows } = await q(sql, [skip]);
				if (rows.length === 0) break;
				for (const r of rows) {
					try {
						const got = await ctx.storage.get(r.storage_path);
						if (!got) {
							missing.add(`${table}:${r.id}`);
							skip.push(String(r.id));
							continue;
						}
						let doc;
						try {
							// Only moved, not new: other modules aren't told (announce: false).
							doc = await fileDocument({ ...metaOf(r), filename: fileName(r.file_name, r.content_type), data: got.data, content_type: r.content_type || undefined }, user, { announce: false });
						} catch (err) {
							// An account that no longer exists, a vendor that is gone: the file matters more than its details.
							if (err?.status !== 422) throw err;
							const { kind } = metaOf(r);
							doc = await fileDocument({ kind, filename: fileName(r.file_name, r.content_type), data: got.data, content_type: r.content_type || undefined }, user, { announce: false });
						}
						await q(`UPDATE ${T(table)} SET document_id = $2, storage_path = NULL WHERE ${key} = $1`, [r.id, String(doc.id)]);
						await ctx.storage.remove(r.storage_path).catch(() => false);
						moved++;
					} catch (err) {
						skip.push(String(r.id));
						ctx.log.warn("file not moved to Documents; it stays where it is", { table, id: String(r.id), err: String(err?.message || err) });
					}
				}
			}
		}
		return { moved, missing: missing.size };
	}

	// -----------------------------------------------------------------------
	// What was read out of a file, kept with it by Ledger for every module (Ledger 0.27.0)
	// -----------------------------------------------------------------------

	/** What was read out of a document ({ data, text, module_id, … }), or null: nobody has read it, or it is gone. */
	async function extractedOf(documentId) {
		if (documentId === null || documentId === undefined || typeof ctx.documents?.extracted !== "function") return null;
		try {
			return await ctx.documents.extracted(documentId);
		} catch {
			return null;
		}
	}

	/**
	 * Saves what this module read out of a document ({ data?, text?, replace? }); Ledger merges it
	 * key by key into what is there. Best effort: → true when saved.
	 */
	async function saveExtracted(documentId, x, user) {
		if (documentId === null || documentId === undefined || typeof ctx.documents?.setExtracted !== "function") return false;
		try {
			await ctx.documents.setExtracted(documentId, x, user);
			return true;
		} catch (err) {
			ctx.log.warn("what was read from a document could not be saved with it", { document: String(documentId), err: String(err?.message || err) });
			return false;
		}
	}

	return {
		extractedOf, saveExtracted,
		fileDocument, saveBillFile, saveStatementFile, readBillFile, readStatementFile, removeBillFile, removeStatementFile,
		billFileUrl: (id) => urlOf("bill", id), statementFileUrl: (id) => urlOf("statement", id),
		billDocumentId: (id) => documentIdOf("bill", id), statementDocumentId: (id) => documentIdOf("statement", id),
		updateDocument, updateBillDocument, usesOf, removeDocumentIfUnused, pendingInStorage, moveStorageToDocuments,
	};
}

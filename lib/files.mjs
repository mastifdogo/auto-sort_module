// Files the module keeps (bill PDFs and photos, statement files) live in Ledger's storage
// (ctx.storage, Ledger 0.13.2), which every backup carries; bill_documents and statement_files say
// what each one is and where it's stored. Files from before 0.8.0 were in those tables' content
// column: they're read from there until moveOldFiles() has moved them.

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

/**
 * h: { q, T }. Reads and writes the module's files, and moves pre-0.8.0 ones out of the database.
 */
export function moduleFiles(ctx, { q, T }) {
	/** Saves a bill's document. */
	async function saveBillFile(billId, { filename, contentType, data }) {
		const path = billFilePath(billId, filename || "document", contentType);
		const f = await ctx.storage.put(path, data);
		await q(
			`INSERT INTO ${T("bill_documents")} (bill_id, file_name, content_type, size_bytes, storage_path) VALUES ($1, $2, $3, $4, $5)
			 ON CONFLICT (bill_id) DO UPDATE SET file_name = EXCLUDED.file_name, content_type = EXCLUDED.content_type, size_bytes = EXCLUDED.size_bytes,
			                                     storage_path = EXCLUDED.storage_path, content = NULL`,
			[billId, String(filename || "document").slice(0, 200), contentType, f.size, f.path],
		);
		return f;
	}

	/** Saves a statement's file. */
	async function saveStatementFile(statementId, { filename, contentType, data }) {
		const path = statementFilePath(statementId, filename || "statement", contentType);
		const f = await ctx.storage.put(path, data);
		await q(
			`INSERT INTO ${T("statement_files")} (statement_id, file_name, content_type, size_bytes, storage_path) VALUES ($1, $2, $3, $4, $5)
			 ON CONFLICT (statement_id) DO UPDATE SET file_name = EXCLUDED.file_name, content_type = EXCLUDED.content_type, size_bytes = EXCLUDED.size_bytes,
			                                          storage_path = EXCLUDED.storage_path, content = NULL`,
			[statementId, String(filename || "statement").slice(0, 200), contentType, f.size, f.path],
		);
		return f;
	}

	/** A file's row and bytes ({ name, type, data, url }), or null. */
	async function read(table, key, id) {
		const { rows } = await q(`SELECT file_name, content_type, content, storage_path FROM ${T(table)} WHERE ${key} = $1`, [String(id)]);
		const r = rows[0];
		if (!r) return null;
		if (r.storage_path) {
			const got = await ctx.storage.get(r.storage_path);
			return got ? { name: r.file_name, type: r.content_type, data: got.data, url: ctx.storage.url(r.storage_path) } : null;
		}
		return r.content ? { name: r.file_name, type: r.content_type, data: r.content, url: null } : null;
	}
	const readBillFile = (billId) => read("bill_documents", "bill_id", billId);
	const readStatementFile = (statementId) => read("statement_files", "statement_id", statementId);

	/** Removes a file from storage (its row goes with its bill or statement). */
	async function removeFile(table, key, id) {
		const { rows } = await q(`SELECT storage_path FROM ${T(table)} WHERE ${key} = $1`, [String(id)]);
		if (rows[0]?.storage_path) await ctx.storage.remove(rows[0].storage_path).catch(() => false);
	}
	const removeBillFile = (billId) => removeFile("bill_documents", "bill_id", billId);
	const removeStatementFile = (statementId) => removeFile("statement_files", "statement_id", statementId);

	/** Moves files kept in the database before 0.8.0 to storage, a few at a time. Returns how many moved. */
	async function moveOldFiles() {
		let moved = 0;
		for (const [table, key, pathOf] of [
			["bill_documents", "bill_id", billFilePath],
			["statement_files", "statement_id", statementFilePath],
		]) {
			for (;;) {
				const { rows } = await q(`SELECT ${key} AS id, file_name, content_type, content FROM ${T(table)} WHERE content IS NOT NULL AND storage_path IS NULL LIMIT 10`);
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

	return { saveBillFile, saveStatementFile, readBillFile, readStatementFile, removeBillFile, removeStatementFile, moveOldFiles };
}

// A scratch PostgreSQL database with the module's schema, for the tests that need real SQL (the
// hand-over from Import, the migrations). Needs a PostgreSQL to create it in (TEST_DATABASE_URL,
// default the local one) and the pg driver of a Ledger checkout ($LEDGER_DIR, or ../Bookeeping,
// ../Accounting, ../ledger beside this repository); null when either is missing (the test is skipped).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ledgerDir = [process.env.LEDGER_DIR, "../../Bookeeping", "../../Accounting", "../../ledger"].filter(Boolean).map((d) => path.resolve(here, d)).find((d) => existsSync(path.join(d, "backend/node_modules/pg/lib/index.js")));
const adminUrl = process.env.TEST_DATABASE_URL || "postgres://postgres:postgres@127.0.0.1:5432/postgres";
const mdir = path.join(here, "..", "migrations");
export const migrationFiles = () => readdirSync(mdir).filter((f) => f.endsWith(".sql")).sort();
let n = 0;

/**
 * → { q(sql, params), migrate(file), end() } with the module's migrations applied in mod_categorizer
 * (all of them, or those before `before`), as Ledger's installer applies them: each in a
 * transaction with the schema as search_path. settingsTable: also Ledger's module_settings.
 */
export async function scratchDatabase({ before = null, settingsTable = false } = {}) {
	if (!ledgerDir) return null;
	const pg = (await import(path.join(ledgerDir, "backend/node_modules/pg/lib/index.js"))).default;
	pg.types.setTypeParser(20, (v) => BigInt(v)); // BIGINT as bigint, as Ledger hands it to modules
	const admin = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 3000 });
	try {
		await admin.connect();
	} catch {
		return null;
	}
	const name = `categorizer_test_${process.pid}_${Date.now()}_${++n}`;
	await admin.query(`CREATE DATABASE ${name}`);
	const url = new URL(adminUrl);
	url.pathname = `/${name}`;
	const db = new pg.Client({ connectionString: url.toString() });
	await db.connect();
	await db.query("CREATE SCHEMA mod_categorizer");
	const migrate = async (f) => {
		try {
			await db.query(`BEGIN; SET LOCAL search_path = mod_categorizer; ${readFileSync(path.join(mdir, f), "utf8")}\n; COMMIT;`);
		} catch (err) {
			await db.query("ROLLBACK").catch(() => {});
			throw err;
		}
	};
	for (const f of migrationFiles()) {
		if (before && f >= before) break;
		await migrate(f);
	}
	if (settingsTable) await db.query(`CREATE TABLE public.module_settings (module_id text PRIMARY KEY, "values" jsonb NOT NULL DEFAULT '{}')`);
	return {
		q: (sql, params) => db.query(sql, params).then((r) => ({ rows: r.rows, rowCount: r.rowCount ?? 0 })),
		migrate,
		async end() {
			await db.end();
			await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
			await admin.end();
		},
	};
}

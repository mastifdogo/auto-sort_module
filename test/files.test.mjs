import assert from "node:assert/strict";
import { test } from "node:test";
import { billFilePath, statementFilePath, storageName } from "../lib/files.mjs";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._ ()-]{0,127}$/; // Ledger's storage path segment (module-storage.ts)

test("file names become paths Ledger's storage accepts, with an extension for their type", () => {
	const cases = [
		["Rogers March.pdf", "application/pdf", "Rogers March.pdf"],
		["été facture", "application/pdf", "ete facture.pdf"],
		[".hidden", "image/png", "hidden.png"],
		["../../etc/passwd", "text/plain", "etc-passwd.txt"],
		["", "text/csv", "file.csv"],
		["visa_2026.OFX", "application/x-ofx", "visa_2026.OFX"],
		["a/b\\c:d?.jpg", "image/jpeg", "a-b-c-d-.jpg"],
	];
	for (const [name, type, want] of cases) {
		const got = storageName(name, type);
		assert.equal(got, want, name);
		assert.match(got, SEGMENT);
	}
	assert.equal(storageName("x".repeat(300), "application/pdf").length, 104);
	assert.equal(billFilePath(7, "scan", "image/jpeg"), "bills/7/scan.jpg");
	assert.equal(statementFilePath(3, "march.csv", "text/csv"), "statements/3/march.csv");
});

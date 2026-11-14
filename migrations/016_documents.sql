-- Ledger 0.19.0 has one store for PDFs and scans (Documents), shared with every module. Bill
-- documents and PDF statements are filed there; these tables keep the document's id.
-- Other statement files (CSV, OFX) stay in the module's storage.
ALTER TABLE bill_documents ADD COLUMN document_id bigint;
ALTER TABLE statement_files ADD COLUMN document_id bigint;

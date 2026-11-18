-- Ledger 0.27.0: modules keep no files of their own. Every file (PDFs, scans, and now CSV, OFX,
-- QFX and saved emails too) is one of Ledger's Documents, and these tables keep only its id.
--
-- The bytes kept here before 0.8.0 (the content columns) were moved out by every version since,
-- when Ledger started. Should a row still hold some, this migration stops, nothing is changed and
-- the installed version keeps running (it moves them when Ledger starts): restart Ledger, wait a
-- minute, and update again.
DO $$
DECLARE
    left_over bigint;
BEGIN
    SELECT (SELECT count(*) FROM bill_documents WHERE content IS NOT NULL)
         + (SELECT count(*) FROM statement_files WHERE content IS NOT NULL)
      INTO left_over;
    IF left_over > 0 THEN
        RAISE EXCEPTION 'Auto sort 0.17.0 cannot be installed yet: % file(s) are still kept as bytes in its tables (bill_documents.content, statement_files.content). The installed version moves them out when Ledger starts: restart Ledger, wait a minute, then update Auto sort again. Nothing was changed.', left_over;
    END IF;
END
$$;

ALTER TABLE bill_documents DROP COLUMN content;
ALTER TABLE statement_files DROP COLUMN content;
-- storage_path stays for now: files still in the module's old storage (CSV and OFX statements,
-- pictures other than PNG and JPEG) are filed in Documents when Ledger starts, and the path says
-- which file is whose. A later version drops it.

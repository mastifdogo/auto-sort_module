-- Ledger 0.13.2 keeps modules' files on its data share (ctx.storage), and every backup carries them.
-- Bill documents and statement files move there: these tables keep what each file is (name, type,
-- size, date) and where it's stored. The bytes already here are moved by the module after it
-- starts, then left empty. Bills can also come from Settings → Auto sort → Import from CSV.
ALTER TABLE bill_documents ALTER COLUMN size_bytes DROP EXPRESSION;
ALTER TABLE bill_documents ALTER COLUMN content DROP NOT NULL;
ALTER TABLE bill_documents ADD COLUMN storage_path text;

ALTER TABLE statement_files ALTER COLUMN size_bytes DROP EXPRESSION;
ALTER TABLE statement_files ALTER COLUMN content DROP NOT NULL;
ALTER TABLE statement_files ADD COLUMN storage_path text;

ALTER TABLE bills DROP CONSTRAINT bills_source_check;
ALTER TABLE bills ADD CONSTRAINT bills_source_check CHECK (source IN ('email', 'upload', 'module', 'statement', 'import'));

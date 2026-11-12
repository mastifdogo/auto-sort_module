-- Backup CSVs show only the size of binary columns (Ledger 0.13.1): keep each file's name, type,
-- size and date readable beside its bytes.
ALTER TABLE bill_documents ADD COLUMN size_bytes bigint GENERATED ALWAYS AS (octet_length(content)) STORED;
ALTER TABLE bill_documents ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
UPDATE bill_documents d SET created_at = b.created_at FROM bills b WHERE b.id = d.bill_id;

ALTER TABLE statement_files ADD COLUMN file_name text NOT NULL DEFAULT '';
ALTER TABLE statement_files ADD COLUMN size_bytes bigint GENERATED ALWAYS AS (octet_length(content)) STORED;
ALTER TABLE statement_files ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
UPDATE statement_files f SET file_name = s.filename, created_at = s.created_at FROM statements s WHERE s.id = f.statement_id;

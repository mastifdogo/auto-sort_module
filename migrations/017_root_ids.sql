-- Root mode (Ledger 0.21.1) keeps a row it deletes or changes so it can be put back, but only in
-- tables with an id column. These four had none.
ALTER TABLE bill_documents ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY UNIQUE;
ALTER TABLE statement_files ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY UNIQUE;
ALTER TABLE not_duplicates ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY UNIQUE;
ALTER TABLE received_files ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY UNIQUE;

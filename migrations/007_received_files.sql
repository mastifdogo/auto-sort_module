-- Files other modules send Auto sort through Ledger (ctx.files, Ledger 0.11.0):
-- what each one became.
ALTER TABLE bills DROP CONSTRAINT bills_source_check;
ALTER TABLE bills ADD CONSTRAINT bills_source_check CHECK (source IN ('email', 'upload', 'module'));
ALTER TABLE statements DROP CONSTRAINT statements_source_check;
ALTER TABLE statements ADD CONSTRAINT statements_source_check CHECK (source IN ('upload', 'email', 'module'));

CREATE TABLE received_files (
    file_id      bigint      PRIMARY KEY,
    outcome      text        NOT NULL CHECK (outcome IN ('statement', 'bill', 'receipt', 'duplicate', 'rejected')),
    statement_id bigint      REFERENCES statements (id) ON DELETE SET NULL,
    bill_id      bigint      REFERENCES bills (id) ON DELETE SET NULL,
    message      text        NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now()
);

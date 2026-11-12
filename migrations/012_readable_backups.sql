-- Ledger 0.13.0 also saves each module table as a CSV beside every backup, for people to open in
-- a spreadsheet. Files (bill PDFs and photos, statement files) move out of the bills and statements
-- tables into their own, so those stay readable; the email checker's log (unused since 0.6.0) goes.
CREATE TABLE bill_documents (
    bill_id      bigint PRIMARY KEY REFERENCES bills (id) ON DELETE CASCADE,
    file_name    text   NOT NULL DEFAULT '',
    content_type text   NOT NULL DEFAULT '',
    content      bytea  NOT NULL
);
INSERT INTO bill_documents (bill_id, file_name, content_type, content)
     SELECT id, COALESCE(document_name, ''), COALESCE(document_type, ''), document FROM bills WHERE document IS NOT NULL;
ALTER TABLE bills DROP COLUMN document;
ALTER TABLE bills DROP COLUMN document_name;
ALTER TABLE bills DROP COLUMN document_type;

CREATE TABLE statement_files (
    statement_id bigint PRIMARY KEY REFERENCES statements (id) ON DELETE CASCADE,
    content_type text   NOT NULL DEFAULT '',
    content      bytea  NOT NULL
);
INSERT INTO statement_files (statement_id, content_type, content)
     SELECT id, COALESCE(document_type, ''), document FROM statements WHERE document IS NOT NULL;
ALTER TABLE statements DROP COLUMN document;
ALTER TABLE statements DROP COLUMN document_type;

DROP TABLE mail_seen;

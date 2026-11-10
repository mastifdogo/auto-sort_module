-- 0.7.0: bills and receipts can be billable to a customer and split into lines, a bill can be
-- made from a statement's balance, and statements keep their file so the LLM can read it later.
ALTER TABLE bills ADD COLUMN billable boolean NOT NULL DEFAULT false;
ALTER TABLE bills ADD COLUMN customer_name text NOT NULL DEFAULT '';
ALTER TABLE bills ADD COLUMN customer_ref text NOT NULL DEFAULT '';   -- e.g. "sales:12" (a Sales module customer)
ALTER TABLE bills ADD COLUMN statement_id bigint REFERENCES statements (id) ON DELETE SET NULL;
ALTER TABLE bills DROP CONSTRAINT bills_source_check;
ALTER TABLE bills ADD CONSTRAINT bills_source_check CHECK (source IN ('email', 'upload', 'module', 'statement'));

-- A split receipt or bill: what each part was for. The amounts add up to the bill's amount.
CREATE TABLE bill_lines (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    bill_id      bigint      NOT NULL REFERENCES bills (id) ON DELETE CASCADE,
    line_no      int         NOT NULL,
    description  text        NOT NULL DEFAULT '',
    amount_cents bigint      NOT NULL CHECK (amount_cents > 0),
    account_code text        NOT NULL,
    UNIQUE (bill_id, line_no)
);

ALTER TABLE statements ADD COLUMN document bytea;
ALTER TABLE statements ADD COLUMN document_type text;

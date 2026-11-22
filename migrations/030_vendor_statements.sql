-- 0.31.0: a vendor's statement of account (the supplier's list of their invoices, our payments
-- and credit notes, with the balance they say is owed) is not a bill: nothing is posted for it.
-- It is kept as a document of its own kind and reconciled against the vendor's own account on
-- Ledger's Reconcile page (ctx.reconcile, Ledger 0.34.0).
--   bills.kind 'vendor_statement':  the row a bill or receipt has, so its document, the inbox file
--                                   it came from and its vendor stay as they are when a person
--                                   says "this is a vendor statement" (and back). Its status is
--                                   'ignored' for as long as it is one: no bill query matches it,
--                                   pays it, lists it or reminds of it. bill_date is the
--                                   statement's date.
--   vendor_statements:              what only a statement has. reconciliation_id is the
--                                   reconciliation in Ledger started for it; its state (in
--                                   progress, finished) is read from Ledger, never copied here.
--                                   was_kind / was_status: what the row was before a person made
--                                   it a vendor statement (NULL: it was read as one), to put back.
--   vendor_statement_lines:         the statement's lines as read or typed, in the vendor
--                                   account's own sign: invoices and charges positive, payments
--                                   and credit notes negative.
ALTER TABLE bills DROP CONSTRAINT bills_kind_check;
ALTER TABLE bills ADD CONSTRAINT bills_kind_check CHECK (kind IN ('bill', 'receipt', 'vendor_statement'));
-- A file another module sent can turn out to be one.
ALTER TABLE received_files DROP CONSTRAINT received_files_outcome_check;
ALTER TABLE received_files ADD CONSTRAINT received_files_outcome_check CHECK (outcome IN ('statement', 'bill', 'receipt', 'vendor_statement', 'duplicate', 'rejected'));

CREATE TABLE vendor_statements (
    id                    bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    bill_id               bigint      NOT NULL UNIQUE REFERENCES bills (id) ON DELETE CASCADE,
    period_start          date,
    opening_balance_cents bigint,
    closing_balance_cents bigint,
    reconciliation_id     bigint,
    started_by            text,
    read_by               text        NOT NULL DEFAULT '' CHECK (read_by IN ('', 'ai', 'person')),
    was_kind              text        CHECK (was_kind IN ('bill', 'receipt')),
    was_status            text        CHECK (was_status IN ('new', 'open', 'paid', 'ignored')),
    created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vendor_statement_lines (
    id           bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    bill_id      bigint  NOT NULL REFERENCES bills (id) ON DELETE CASCADE,
    line_no      int     NOT NULL,
    line_date    date    NOT NULL,
    description  text    NOT NULL DEFAULT '',
    amount_cents bigint  NOT NULL CHECK (amount_cents <> 0)
);
CREATE INDEX vendor_statement_lines_bill ON vendor_statement_lines (bill_id, line_no);

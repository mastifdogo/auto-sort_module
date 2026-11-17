-- 0.16.0: what a statement says is owed, kept once it has been read, so Create bill doesn't ask the
-- LLM again. Filled from the PDF reading (the same LLM call that lists the transactions), an OFX
-- file's ledger balance, what the sending module said, or an earlier Create bill reading.
-- { from: "pdf"|"ofx"|"module"|"llm", vendor, statement_date, due_date, amount_cents, minimum_cents,
--   reference, currency, balance_cents, balance_date, confidence, summary } (amounts as strings).
ALTER TABLE statements ADD COLUMN bill_info jsonb;

-- The individual line items read from a scanned bill or receipt: what was bought, how many, at
-- what price. A billable item is put on the bill's journal entry as one of Ledger's rate items
-- (tag "rate": description, quantity, unit, rate; Ledger 0.25.0), so an invoice can be filled
-- from it. rate_entry_id / rate_tag_id: the entry and rate item it is on.
CREATE TABLE bill_items (
    id            bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    bill_id       bigint        NOT NULL REFERENCES bills (id) ON DELETE CASCADE,
    line_no       int           NOT NULL,
    description   text          NOT NULL DEFAULT '',
    quantity      numeric(18,4),
    unit          text          NOT NULL DEFAULT '',
    rate_cents    bigint        CHECK (rate_cents >= 0),
    amount_cents  bigint,
    billable      boolean       NOT NULL DEFAULT false,
    rate_entry_id bigint,
    rate_tag_id   bigint,
    UNIQUE (bill_id, line_no)
);

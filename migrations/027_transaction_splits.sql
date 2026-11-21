-- 0.24.0: a bank line larger than the bill or receipt it pays can be split into several lines:
-- the bill's amount pays it, and each line here books a part of the rest to its own account.
-- transactions.split_cents stays the rest's total (rows from before have one line, in
-- split_account_code and split_memo).
CREATE TABLE transaction_splits (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transaction_id bigint NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    line_no        int    NOT NULL,
    amount_cents   bigint NOT NULL CHECK (amount_cents > 0),
    account_code   text   NOT NULL,
    memo           text   NOT NULL DEFAULT ''
);
CREATE INDEX transaction_splits_tx ON transaction_splits (transaction_id, line_no);

-- 0.20.0: on the Duplicates tab an entry can be skipped (hidden for now, not marked "not
-- duplicates"), and skips can be listed and undone. Kinds: 'pair' (two staged rows), 'entry' (a
-- staged row and a journal entry), 'bill' (a bill or receipt and a journal entry).
CREATE TABLE duplicate_skips (
    id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind       text        NOT NULL CHECK (kind IN ('pair', 'entry', 'bill')),
    tx_id      bigint      REFERENCES transactions (id) ON DELETE CASCADE,
    other_id   bigint      REFERENCES transactions (id) ON DELETE CASCADE,
    entry_id   bigint,
    bill_id    bigint      REFERENCES bills (id) ON DELETE CASCADE,
    created_by text        NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX duplicate_skips_key ON duplicate_skips (kind, COALESCE(tx_id, 0), COALESCE(other_id, 0), COALESCE(entry_id, 0), COALESCE(bill_id, 0));

-- A bank line that pays a bill or receipt for less than the whole line is split: the bill's
-- amount pays it, the rest (split_cents, positive) goes to split_account_code.
ALTER TABLE transactions ADD COLUMN split_cents bigint CHECK (split_cents > 0);
ALTER TABLE transactions ADD COLUMN split_account_code text;
ALTER TABLE transactions ADD COLUMN split_memo text NOT NULL DEFAULT '';

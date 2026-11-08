-- Duplicate transactions can be merged into the one kept (status 'merged'), and the
-- AI can propose a new account when none of the existing ones fits.
ALTER TABLE transactions DROP CONSTRAINT transactions_status_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_status_check CHECK (status IN ('new', 'posting', 'posted', 'skipped', 'merged'));
ALTER TABLE transactions ADD COLUMN duplicate_of bigint REFERENCES transactions (id) ON DELETE SET NULL;
ALTER TABLE transactions ADD COLUMN duplicate_entry_id bigint;
ALTER TABLE transactions ADD COLUMN new_account jsonb;

-- Pairs someone said aren't duplicates: another row (other_id) or a journal entry (entry_id).
CREATE TABLE not_duplicates (
    tx_id      bigint      NOT NULL REFERENCES transactions (id) ON DELETE CASCADE,
    other_id   bigint      REFERENCES transactions (id) ON DELETE CASCADE,
    entry_id   bigint,
    created_by text        NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((other_id IS NULL) <> (entry_id IS NULL))
);
CREATE UNIQUE INDEX not_duplicates_pair ON not_duplicates (tx_id, COALESCE(other_id, 0), COALESCE(entry_id, 0));

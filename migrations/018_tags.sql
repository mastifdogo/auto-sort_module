-- Ledger 0.23.0: tags on journal entries, shared by Ledger and every module.
-- A bill whose entry another module or a person tagged "paid" is paid here without a payment of
-- its own: paid_by_tag says so and paid_tag_by who tagged it. tags_synced_at: when the bill's
-- entry first got its tags (bills from before this version get them once, at startup).
ALTER TABLE bills ADD COLUMN paid_by_tag boolean NOT NULL DEFAULT false;
ALTER TABLE bills ADD COLUMN paid_tag_by text;
ALTER TABLE bills ADD COLUMN tags_synced_at timestamptz;
-- A statement row that pays an entry another module tagged as owed (billed, overdue, a vendor's):
-- posting the row tags that entry "paid". rejected_pays_entry_id: "Not this one", not offered again.
ALTER TABLE transactions ADD COLUMN pays_entry_id bigint;
ALTER TABLE transactions ADD COLUMN rejected_pays_entry_id bigint;
ALTER TABLE transactions DROP CONSTRAINT transactions_source_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_source_check CHECK (source IN ('', 'llm', 'rule', 'error', 'bill', 'transfer', 'tag'));

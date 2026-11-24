-- 0.34.0: a bill or receipt linked by hand to a journal entry for a different amount can split
-- that entry. Ledger adds no lines to a posted entry, so the split is an entry of its own that
-- moves the parts out of the entry's line into the accounts the person chose.
--   bills.split_entry_id: that entry, reversed when the bill is unlinked from the entry again.
ALTER TABLE bills ADD COLUMN split_entry_id bigint;

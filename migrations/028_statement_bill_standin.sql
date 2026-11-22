-- 0.29.0: a bill made with Create bill on a card or loan statement no longer goes through the
-- module's clearing account. It is posted Dr accounts payable (a stand-in) / Cr the vendor's own
-- account, and the stand-in line moves to the card or loan account when the payment on that
-- account's statement is linked to the bill (ctx.ledger.moveLine, Ledger 0.32.0).
--   standin_account_code: accounts payable as the stand-in line was posted to it (where the line
--                         goes back to when the row is unlinked); NULL: not such a bill (every
--                         other bill, and the ones posted to "Statement bills to clear" before).
--   standin_line:         the stand-in line's number in the bill's entry, while it is posted.
--   standin_tx_id:        the statement row linked to it (that row is settled by the bill's entry).
ALTER TABLE bills ADD COLUMN standin_account_code text;
ALTER TABLE bills ADD COLUMN standin_line int;
ALTER TABLE bills ADD COLUMN standin_tx_id bigint REFERENCES transactions (id) ON DELETE SET NULL;
CREATE UNIQUE INDEX bills_standin_tx ON bills (standin_tx_id) WHERE standin_tx_id IS NOT NULL;

-- 0.30.0: payments are linked to a bill's entry through Ledger (ctx.ledger.linkPayment, Ledger
-- 0.33.0), which shows them on the entry and keeps its tag unpaid, partially_paid or paid. No line
-- of a bill's entry is moved any more when the payment on the card's or loan's statement is linked
-- to a bill made with Create bill on a statement: that row is posted as an entry of its own.
--   bills.payments_linked_at:      when the payments already posted for the bill were linked to its
--                                  entry in Ledger (at approval, or by the backfill at startup).
--                                  From then on Ledger's linked payments say what is paid and
--                                  what is left; NULL: the module's own payment rows do (an older
--                                  Ledger, a bill without an entry of its own, not linked yet).
--   transactions.standin_bill_id:  the bill made from a statement whose stand-in in accounts
--                                  payable this row clears: the row is posted in its own entry
--                                  (Dr the card or loan account / Cr accounts payable), linked to
--                                  the bill's entry. bills.standin_tx_id stays for the bills linked
--                                  the 0.29.0 way (their stand-in line was moved; one row a bill).
ALTER TABLE bills ADD COLUMN payments_linked_at timestamptz;
ALTER TABLE transactions ADD COLUMN standin_bill_id bigint REFERENCES bills (id) ON DELETE SET NULL;
CREATE INDEX transactions_standin_bill ON transactions (standin_bill_id) WHERE standin_bill_id IS NOT NULL;

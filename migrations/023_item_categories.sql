-- A line item of a bill or receipt can have its own account (category). Items without one, and
-- whatever the items don't cover (tax, a tip), go to the bill's own account as before. The bill is
-- then booked line by line (bill_lines, made from the items: lines_from_items).
ALTER TABLE bill_items ADD COLUMN account_code text;
ALTER TABLE bills ADD COLUMN lines_from_items boolean NOT NULL DEFAULT false;

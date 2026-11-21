-- 0.23.0: the AI proposes a tax for each line item it reads. Only a suggestion (preselected in
-- the tax picker): the item's tax (tax_id) is set when a person saves the items.
ALTER TABLE bill_items ADD COLUMN suggested_tax_id bigint REFERENCES taxes (id) ON DELETE SET NULL;

-- A tax for the whole bill or receipt: every line item has it unless the item has a tax of its own
-- or none (no_tax), and what the items don't cover is taken as including it.
ALTER TABLE bills ADD COLUMN tax_id bigint REFERENCES taxes (id);
ALTER TABLE bill_items ADD COLUMN no_tax boolean NOT NULL DEFAULT false;

-- Ledger 0.16.0 keeps one list of customers and vendors (entities) for Ledger and every module.
-- A bill links to its vendor and customer there; customer_name / vendor stay as typed.
ALTER TABLE bills ADD COLUMN vendor_entity_id bigint;
ALTER TABLE bills ADD COLUMN customer_entity_id bigint;

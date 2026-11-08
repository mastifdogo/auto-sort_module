-- The Import tab's log: which statement an email became, and who sent it.
ALTER TABLE mail_seen ADD COLUMN statement_id bigint REFERENCES statements (id) ON DELETE SET NULL;
ALTER TABLE mail_seen ADD COLUMN mail_from text NOT NULL DEFAULT '';

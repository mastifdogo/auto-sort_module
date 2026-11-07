-- Statements found in email: where a statement came from, statements waiting
-- for you to choose their account, and which account each sender's statements go to.

ALTER TABLE statements ADD COLUMN source text NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'email'));
ALTER TABLE statements ADD COLUMN message_id text;
ALTER TABLE statements ADD COLUMN mail_from text NOT NULL DEFAULT '';
ALTER TABLE statements ADD COLUMN mail_subject text NOT NULL DEFAULT '';
-- Sender and account-number hint (e.g. "alerts@bank.com|4411"): how the account is remembered.
ALTER TABLE statements ADD COLUMN source_key text;
CREATE INDEX statements_message ON statements (message_id) WHERE message_id IS NOT NULL;

-- 'needs_account': staged from email, but which account it belongs to isn't known yet.
ALTER TABLE statements DROP CONSTRAINT statements_status_check;
ALTER TABLE statements ADD CONSTRAINT statements_status_check CHECK (status IN ('queued', 'categorizing', 'ready', 'error', 'needs_account'));

CREATE TABLE statement_sources (
    source_key   text        PRIMARY KEY,
    account_code text        NOT NULL,
    flip_signs   boolean     NOT NULL DEFAULT false,
    updated_by   text        NOT NULL,
    updated_at   timestamptz NOT NULL DEFAULT now()
);

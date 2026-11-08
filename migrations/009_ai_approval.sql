-- AI output waits for a person (Ledger's module rule): the account the AI guessed for a statement
-- is only offered, and a file read by the AI is marked done for its sender only once someone approves.
ALTER TABLE statements ADD COLUMN account_guess text;
ALTER TABLE received_files ADD COLUMN pending boolean NOT NULL DEFAULT false;
ALTER TABLE received_files ADD COLUMN settled_by text;

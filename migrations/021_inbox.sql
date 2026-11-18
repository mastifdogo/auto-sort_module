-- 0.17.0: the Import module (id "downloads") is merged into Auto sort. Its inbox, what the AI read
-- from a file (waiting for a person), the email check's log and what it learned live here now.
-- Every file is one of Ledger's Documents: inbox_files keeps the document's id, never bytes.

CREATE TABLE inbox_files (
    id                  bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name                text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 255),
    content_type        text        NOT NULL DEFAULT '',
    size_bytes          bigint      NOT NULL CHECK (size_bytes >= 0),
    sha256              text,
    status              text        NOT NULL DEFAULT 'uploading'
                        CHECK (status IN ('uploading', 'new', 'sent', 'archived')),
    document_id         bigint,                         -- the file in Ledger's Documents (none only while it is uploading)
    document_added_here boolean     NOT NULL DEFAULT false, -- false: the document was there already (someone else added it)
    origin              text        NOT NULL DEFAULT ''
                        CHECK (origin IN ('', 'email', 'scanner', 'camera', 'upload', 'app')),
    origin_detail       text        NOT NULL DEFAULT '', -- the sender, the scanner's name, the phone
    source_url          text        NOT NULL DEFAULT '', -- the page a browser file came from
    note                text        NOT NULL DEFAULT '',
    account_code        text        NOT NULL DEFAULT '', -- the account chosen on the phone for a receipt
    received_by         text        NOT NULL,
    received_at         timestamptz NOT NULL DEFAULT now(),
    sent_to             text        NOT NULL DEFAULT '', -- what it became, e.g. "Statement #12"
    sent_link           text        NOT NULL DEFAULT '', -- a path inside Ledger
    sent_by             text,
    sent_at             timestamptz,
    sent_file_id        bigint,                          -- the hand-off to another module (ctx.files)
    statement_id        bigint      REFERENCES statements (id) ON DELETE SET NULL,
    bill_id             bigint      REFERENCES bills (id) ON DELETE SET NULL,
    mail_features       text[],                          -- what the email check learns from (lib/learn.mjs)
    mail_trained        boolean     NOT NULL DEFAULT false,
    mail_folder         text        NOT NULL DEFAULT '', -- which mailbox and message a file came from
    mail_uid            text        NOT NULL DEFAULT '',
    adopted_from        bigint,                          -- its id in the Import module's inbox, when taken over from there
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inbox_files_status ON inbox_files (status, received_at DESC);
CREATE INDEX inbox_files_sha256 ON inbox_files (sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX inbox_files_document ON inbox_files (document_id) WHERE document_id IS NOT NULL;
CREATE UNIQUE INDEX inbox_files_adopted ON inbox_files (adopted_from) WHERE adopted_from IS NOT NULL;

-- What the AI read from a file (Extract data): a suggestion until a person approves it. Approved,
-- the transactions are saved with the document in Ledger (its extracted data), for every module.
CREATE TABLE inbox_extractions (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    file_id      bigint      NOT NULL REFERENCES inbox_files (id) ON DELETE CASCADE,
    status       text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    model        text        NOT NULL DEFAULT '',
    currency     text        NOT NULL DEFAULT '',
    instructions text        NOT NULL DEFAULT '',
    transactions jsonb       NOT NULL,   -- [{date, description, amount, balance}], as read (and as approved)
    created_by   text        NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    decided_by   text,
    decided_at   timestamptz,
    csv_file_id  bigint,                 -- the CSV the Import module made on approval (before 0.17.0)
    adopted_from bigint                  -- its id in the Import module, when taken over from there
);
CREATE INDEX inbox_extractions_pending ON inbox_extractions (file_id) WHERE status = 'pending';
CREATE UNIQUE INDEX inbox_extractions_adopted ON inbox_extractions (adopted_from) WHERE adopted_from IS NOT NULL;

-- Every email the check looked at, once (per mailbox).
CREATE TABLE mail_seen (
    folder      text        NOT NULL,          -- the mailbox: "imap:me@example.com", "gmail:me@example.com"
    uidvalidity bigint      NOT NULL,
    uid         text        NOT NULL,          -- the message's id in that mailbox
    outcome     text        NOT NULL,          -- files | email_saved | no_document | filtered | sent | duplicate | learned_skip | gone
    files       integer     NOT NULL DEFAULT 0,
    subject     text        NOT NULL DEFAULT '',
    mail_from   text        NOT NULL DEFAULT '',
    reason      text        NOT NULL DEFAULT '',
    mail_date   timestamptz,
    seen_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (folder, uidvalidity, uid)
);

-- What the email check learned: files deleted with "Delete and learn" (-1) and files sent on (1).
CREATE TABLE mail_training (
    id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    label        smallint    NOT NULL CHECK (label IN (-1, 1)),
    features     text[]      NOT NULL,
    sender       text        NOT NULL DEFAULT '',
    subject      text        NOT NULL DEFAULT '',
    file_name    text        NOT NULL DEFAULT '',
    source       text        NOT NULL DEFAULT 'delete' CHECK (source IN ('delete', 'sent', 'import', 'file')),
    created_by   text        NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    adopted_from bigint
);
CREATE INDEX mail_training_created ON mail_training (created_at DESC);
CREATE UNIQUE INDEX mail_training_adopted ON mail_training (adopted_from) WHERE adopted_from IS NOT NULL;

-- Small state the module keeps between runs: the email check's last run ("mail"), and what was
-- taken over from the Import module ("import_adoption").
CREATE TABLE module_state (
    key        text        PRIMARY KEY,
    value      jsonb       NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- What the AI read from a PDF statement another module sent, kept until a person posts from the
-- statement (the approval): then it is saved with the document as its extracted data.
ALTER TABLE statements ADD COLUMN ai_reading jsonb;
-- The document a file from another module is (Ledger 0.27.0 hands files over as documents).
ALTER TABLE received_files ADD COLUMN document_id bigint;

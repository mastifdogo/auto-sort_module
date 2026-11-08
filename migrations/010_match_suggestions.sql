-- Matches the Auto sort button found with the LLM: a statement row or a bill/receipt, and the
-- journal entry, other statement row or bill it is the same transaction as. Pending until a person
-- approves or rejects it (Ledger's rule for AI output).
CREATE TABLE match_suggestions (
    id           bigserial   PRIMARY KEY,
    subject_kind text        NOT NULL CHECK (subject_kind IN ('transaction', 'bill')),
    subject_id   bigint      NOT NULL,
    target_kind  text        NOT NULL CHECK (target_kind IN ('entry', 'transaction', 'bill')),
    target_id    bigint      NOT NULL,
    confidence   real        NOT NULL DEFAULT 0,
    reason       text        NOT NULL DEFAULT '',
    status       text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'failed')),
    error        text,
    created_by   text        NOT NULL DEFAULT '',
    decided_by   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    decided_at   timestamptz,
    UNIQUE (subject_kind, subject_id, target_kind, target_id)
);
CREATE INDEX match_suggestions_pending ON match_suggestions (subject_kind, subject_id) WHERE status = 'pending';

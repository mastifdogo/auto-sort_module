-- What was taken over from the Import module, by the id it had there, kept apart from the rows
-- themselves: a file deleted from the inbox afterwards must not look like one of Import's that
-- still waits to be taken over.
CREATE TABLE adopted_ids (
    kind       text        NOT NULL CHECK (kind IN ('file', 'extraction', 'training')),
    source_id  bigint      NOT NULL,
    adopted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (kind, source_id)
);
INSERT INTO adopted_ids (kind, source_id) SELECT 'file', adopted_from FROM inbox_files WHERE adopted_from IS NOT NULL;
INSERT INTO adopted_ids (kind, source_id) SELECT 'extraction', adopted_from FROM inbox_extractions WHERE adopted_from IS NOT NULL;
INSERT INTO adopted_ids (kind, source_id) SELECT 'training', adopted_from FROM mail_training WHERE adopted_from IS NOT NULL;

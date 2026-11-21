-- 0.22.0: taxes (GST 5%, ...) a person sets up once and chooses on each line item of a bill or
-- receipt. A tax with an account (tax you claim back) is booked there; one without stays with the
-- item's category. The rate is a percentage added to the item's amount.
CREATE TABLE taxes (
    id           bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name         text         NOT NULL CHECK (name <> ''),
    rate         numeric(7,4) NOT NULL CHECK (rate > 0 AND rate <= 100),
    account_code text,
    active       boolean      NOT NULL DEFAULT true,
    created_by   text         NOT NULL DEFAULT '',
    created_at   timestamptz  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX taxes_name ON taxes (lower(name));
ALTER TABLE bill_items ADD COLUMN tax_id bigint REFERENCES taxes (id);

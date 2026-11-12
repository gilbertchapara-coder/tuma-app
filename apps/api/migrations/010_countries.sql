-- Multi-country (12 Nov 2026). A user's country follows the phone number they log in with (+263 Zimbabwe, +260 Zambia).
-- Float, parcels and bundles belong to a country, so money in one currency is never mixed with another.
ALTER TABLE users          ADD COLUMN country text NOT NULL DEFAULT 'ZW';
ALTER TABLE parcels        ADD COLUMN country text NOT NULL DEFAULT 'ZW';
ALTER TABLE bundles        ADD COLUMN country text NOT NULL DEFAULT 'ZW';
ALTER TABLE ledger_entries ADD COLUMN country text NOT NULL DEFAULT 'ZW';

UPDATE users SET country = 'ZM' WHERE phone LIKE '+260%';

CREATE INDEX bundles_country_idx ON bundles (country, status);
CREATE INDEX ledger_entries_country_idx ON ledger_entries (rider_id, country, id);

-- Owner settings per country. Anything null falls back to the built-in default (none for Zambia).
-- platform_bps is Tuma's share of each run price, in basis points (1000 = 10%). Null means not set yet.
CREATE TABLE country_settings (
  country       text PRIMARY KEY,
  suburbs       jsonb,
  prices        jsonb,
  platform_bps  integer CHECK (platform_bps BETWEEN 0 AND 10000),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Tuma pilot schema. Money is integer cents. Ledger and custody rows are append-only.

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text NOT NULL UNIQUE,
  role        text NOT NULL CHECK (role IN ('shop', 'rider', 'admin')),
  first_name  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE otp_challenges (
  phone       text PRIMARY KEY,
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per rider. The row lock on this table serialises everything that moves the rider's float.
CREATE TABLE riders (
  user_id           uuid PRIMARY KEY REFERENCES users(id),
  verified          boolean NOT NULL DEFAULT false,
  has_guarantor     boolean NOT NULL DEFAULT false,
  clean_deliveries  integer NOT NULL DEFAULT 0 CHECK (clean_deliveries >= 0),
  rating            numeric(3, 2) NOT NULL DEFAULT 0 CHECK (rating >= 0 AND rating <= 5)
);

CREATE TABLE ledger_entries (
  id        bigserial PRIMARY KEY,
  rider_id  uuid NOT NULL REFERENCES riders(user_id),
  type      text NOT NULL CHECK (type IN ('topup', 'fee', 'fee_refund', 'deposit_hold', 'loss_payout', 'loss_settled')),
  cents     integer NOT NULL CHECK (cents >= 0),
  at        timestamptz NOT NULL,
  job_id    text,
  pot       text CHECK (pot IN ('deposit', 'float'))
);
CREATE INDEX ledger_entries_rider_idx ON ledger_entries (rider_id, id);
-- A fee is charged at most once per job.
CREATE UNIQUE INDEX ledger_one_fee_per_job ON ledger_entries (job_id) WHERE type = 'fee';

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;

CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE parcels (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id          uuid NOT NULL REFERENCES users(id),
  suburb           text NOT NULL,
  level            text NOT NULL CHECK (level IN ('express', 'standard', 'overnight')),
  value_cents      integer NOT NULL CHECK (value_cents > 0),
  contents         text NOT NULL,
  recipient_phone  text NOT NULL,
  price_cents      integer NOT NULL CHECK (price_cents > 0),
  track_token      text NOT NULL UNIQUE,
  rider_id         uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX parcels_shop_idx ON parcels (shop_id, created_at DESC);

CREATE TABLE custody_events (
  id         bigserial PRIMARY KEY,
  parcel_id  uuid NOT NULL REFERENCES parcels(id),
  type       text NOT NULL,
  at         timestamptz NOT NULL,
  actor      text NOT NULL,
  photo_url  text
);
CREATE INDEX custody_events_parcel_idx ON custody_events (parcel_id, id);
CREATE TRIGGER custody_append_only BEFORE UPDATE OR DELETE ON custody_events
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE delivery_codes (
  parcel_id        uuid PRIMARY KEY REFERENCES parcels(id),
  hash             text NOT NULL,
  salt             text NOT NULL,
  failed_attempts  integer NOT NULL DEFAULT 0,
  used             boolean NOT NULL DEFAULT false,
  locked           boolean NOT NULL DEFAULT false
);

CREATE TABLE bundles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run         text NOT NULL,
  level       text NOT NULL CHECK (level IN ('express', 'standard', 'overnight')),
  drop_order  jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted')),
  rider_id    uuid REFERENCES users(id),
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'open' AND rider_id IS NULL) OR (status = 'accepted' AND rider_id IS NOT NULL))
);

-- A parcel belongs to at most one bundle.
CREATE TABLE bundle_parcels (
  bundle_id  uuid NOT NULL REFERENCES bundles(id),
  parcel_id  uuid NOT NULL UNIQUE REFERENCES parcels(id),
  PRIMARY KEY (bundle_id, parcel_id)
);

-- Extra services (12 Nov 2026): rain extra, direction board / auction, messenger, partner loans.

-- Rain extra and how riders get the parcel. Existing parcels stay table-priced, fixed dispatch.
ALTER TABLE parcels
  ADD COLUMN weather_cents  integer NOT NULL DEFAULT 0 CHECK (weather_cents >= 0),
  ADD COLUMN dispatch_mode  text NOT NULL DEFAULT 'fixed' CHECK (dispatch_mode IN ('fixed', 'first', 'cheapest')),
  ADD COLUMN max_price_cents integer CHECK (max_price_cents > 0);

-- Only one-parcel express bundles can be auctioned: pooled runs mix several shops' parcels.
ALTER TABLE bundles
  ADD COLUMN dispatch_mode    text NOT NULL DEFAULT 'fixed' CHECK (dispatch_mode IN ('fixed', 'first', 'cheapest')),
  ADD COLUMN ceiling_cents    integer CHECK (ceiling_cents > 0),
  ADD COLUMN auction_ends_at  timestamptz;

-- A place in a rider's cart. Not a win: only the award decides.
CREATE TABLE bundle_offers (
  bundle_id   uuid NOT NULL REFERENCES bundles(id),
  rider_id    uuid NOT NULL REFERENCES users(id),
  ask_cents   integer NOT NULL CHECK (ask_cents > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bundle_id, rider_id)
);
CREATE INDEX bundle_offers_rider_idx ON bundle_offers (rider_id);

-- Messenger: one thread per parcel between the shop and the assigned rider. Kept as dispute evidence.
CREATE TABLE messages (
  id         bigserial PRIMARY KEY,
  parcel_id  uuid NOT NULL REFERENCES parcels(id),
  sender_id  uuid NOT NULL REFERENCES users(id),
  body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_parcel_idx ON messages (parcel_id, id);
CREATE INDEX messages_sender_idx ON messages (sender_id, created_at);
CREATE TRIGGER messages_append_only BEFORE UPDATE OR DELETE ON messages
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE TABLE message_reads (
  parcel_id  uuid NOT NULL REFERENCES parcels(id),
  user_id    uuid NOT NULL REFERENCES users(id),
  last_id    bigint NOT NULL,
  PRIMARY KEY (parcel_id, user_id)
);

-- Loans are made by a licensed partner, never by Tuma. This table only records requests and the partner's answers.
CREATE TABLE loans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id),
  principal_cents  integer NOT NULL CHECK (principal_cents > 0),
  repay_cents      integer NOT NULL CHECK (repay_cents >= principal_cents),
  status           text NOT NULL CHECK (status IN ('pending_code', 'requested', 'active', 'repaid', 'late', 'declined', 'cancelled')),
  code_hash        text,
  code_attempts    integer NOT NULL DEFAULT 0,
  code_expires_at  timestamptz,
  partner_ref      text,
  due_at           timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX loans_user_idx ON loans (user_id, created_at DESC);
-- At most one live loan per person.
CREATE UNIQUE INDEX loans_one_live ON loans (user_id) WHERE status IN ('pending_code', 'requested', 'active', 'late');

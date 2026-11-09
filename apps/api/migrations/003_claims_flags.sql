-- Claims, GPS trail, flags and rider removal (Task 9).

ALTER TABLE riders ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed'));

-- One claim per parcel. 'open' = a shop claim after pickup waiting for admin review (pays nothing, no custody event).
CREATE TABLE claims (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parcel_id     uuid NOT NULL UNIQUE REFERENCES parcels(id),
  status        text NOT NULL CHECK (status IN ('open', 'settled')),
  filed_by      text NOT NULL CHECK (filed_by IN ('shop', 'rider', 'admin')),
  liable        text CHECK (liable IN ('shop', 'rider', 'recipient')),
  payout_cents  integer CHECK (payout_cents >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz,
  CHECK ((status = 'open' AND liable IS NULL AND payout_cents IS NULL) OR (status = 'settled' AND liable IS NOT NULL AND payout_cents IS NOT NULL))
);
CREATE INDEX claims_status_idx ON claims (status, created_at);

CREATE TABLE gps_pings (
  id           bigserial PRIMARY KEY,
  rider_id     uuid NOT NULL REFERENCES users(id),
  lat          double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng          double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  at           timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);
-- A repeated ping (client retry) with the same timestamp is stored once.
CREATE UNIQUE INDEX gps_pings_rider_at ON gps_pings (rider_id, at);

-- One flag per (parcel, kind, episode). For a stall the episode is the stall start; otherwise the pickup time.
CREATE TABLE flags (
  id             bigserial PRIMARY KEY,
  parcel_id      uuid NOT NULL REFERENCES parcels(id),
  rider_id       uuid NOT NULL REFERENCES users(id),
  kind           text NOT NULL CHECK (kind IN ('off_route', 'stalled', 'late')),
  episode_start  timestamptz NOT NULL,
  raised_at      timestamptz NOT NULL,
  UNIQUE (parcel_id, kind, episode_start)
);

-- Fix round 1: claims can be dismissed by an admin or closed when the parcel is delivered.
ALTER TABLE claims DROP CONSTRAINT claims_status_check;
ALTER TABLE claims DROP CONSTRAINT claims_check;
ALTER TABLE claims ADD CONSTRAINT claims_status_check CHECK (status IN ('open', 'settled', 'dismissed', 'closed'));
ALTER TABLE claims ADD CONSTRAINT claims_shape_check CHECK (
  (status IN ('open', 'dismissed', 'closed') AND liable IS NULL AND payout_cents IS NULL)
  OR (status = 'settled' AND liable IS NOT NULL AND payout_cents IS NOT NULL)
);
-- Latest-ping lookups for the per-rider rate limit and ordering check.
CREATE INDEX IF NOT EXISTS gps_pings_rider_at_desc ON gps_pings (rider_id, at DESC);

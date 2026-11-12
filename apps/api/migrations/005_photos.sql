-- Photos taken in the app (sealed parcel, pickup). Kept in Postgres for the pilot; the app only ever sees a URL,
-- so this can move to object storage later without an app change.
CREATE TABLE photos (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id),
  data       bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 409600),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX photos_owner_idx ON photos (owner_id, created_at DESC);
CREATE INDEX custody_events_photo_idx ON custody_events (photo_url) WHERE photo_url IS NOT NULL;

-- Optional drop-off pin and the distance charge worked out at booking (straight-line km, placeholder rule).
ALTER TABLE parcels ADD COLUMN drop_lat double precision, ADD COLUMN drop_lng double precision,
  ADD COLUMN distance_km numeric(6,1), ADD COLUMN distance_cents integer NOT NULL DEFAULT 0;

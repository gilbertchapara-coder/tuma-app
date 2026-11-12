-- One-time code the customer gives the sender at a third-party pickup address. The rider enters it to confirm pickup.
CREATE TABLE pickup_codes (
  parcel_id       uuid PRIMARY KEY REFERENCES parcels(id),
  hash            text NOT NULL,
  salt            text NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0,
  used            boolean NOT NULL DEFAULT false,
  locked          boolean NOT NULL DEFAULT false
);

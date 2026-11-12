-- Customers are senders who are not shops. They use the shop role (book, track, message); kind tells them apart.
ALTER TABLE users ADD COLUMN kind text NOT NULL DEFAULT 'shop' CHECK (kind IN ('shop', 'customer'));

-- A pickup request: collect from another location, then deliver. Payment is made directly to the rider.
ALTER TABLE parcels
  ADD COLUMN pickup_suburb text,
  ADD COLUMN pickup_note   text,
  ADD COLUMN pickup_lat    double precision,
  ADD COLUMN pickup_lng    double precision,
  ADD COLUMN pay_method    text NOT NULL DEFAULT 'cash' CHECK (pay_method IN ('cash', 'mobile_money'));

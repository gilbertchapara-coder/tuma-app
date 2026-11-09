-- Failed OTP verifications per phone, kept across new code requests.
CREATE TABLE otp_failures (
  phone         text PRIMARY KEY,
  failures      integer NOT NULL DEFAULT 0,
  window_start  timestamptz NOT NULL DEFAULT now(),
  locked_until  timestamptz
);

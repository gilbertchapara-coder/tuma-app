-- Intelligence layer (12 Nov 2026). Public news about delivery and rider apps, fetched on request by an admin.
-- Advisory only: nothing here changes prices, percentages or settings. No user data is ever stored here or sent out.
CREATE TABLE insights (
  id            bigserial PRIMARY KEY,
  url           text NOT NULL UNIQUE,
  title         text NOT NULL,
  source        text NOT NULL,
  tag           text NOT NULL,
  topic         text NOT NULL,
  summary       text NOT NULL DEFAULT '',
  published_at  timestamptz,
  fetched_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX insights_recent_idx ON insights (published_at DESC NULLS LAST, id DESC);

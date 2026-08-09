CREATE TABLE IF NOT EXISTS requests (
  id          BIGSERIAL PRIMARY KEY,
  method      TEXT,
  route       TEXT,
  status      INT,
  duration_ms DOUBLE PRECISION,
  ts          TIMESTAMPTZ DEFAULT now()
);
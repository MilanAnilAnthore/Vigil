CREATE TABLE IF NOT EXISTS requests (
  request_id  BIGSERIAL PRIMARY KEY,
  method      TEXT,
  route       TEXT,
  status      INT,
  duration_ms DOUBLE PRECISION,
  ts          TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS queries (
  query_id    BIGSERIAL PRIMARY KEY,
  request_id  BIGINT NOT NULL,
  query_text  TEXT,
  duration_ms DOUBLE PRECISION,

  CONSTRAINT fk_request
    FOREIGN KEY (request_id)
    REFERENCES requests(request_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS orders (
  order_id BIGSERIAL PRIMARY KEY,
  user_id  BIGINT NOT NULL,
  amount   NUMERIC(10,2) NOT NULL,
  created  TIMESTAMPTZ DEFAULT now()
);

-- Seed only when the table is empty, so re-running this file is safe.
INSERT INTO orders (user_id, amount)
SELECT (i % 50) + 1, (random() * 500)::numeric(10,2)
FROM generate_series(1, 5000) AS i
WHERE NOT EXISTS (SELECT 1 FROM orders);

CREATE INDEX IF NOT EXISTS idx_queries_request_id ON queries(request_id);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);
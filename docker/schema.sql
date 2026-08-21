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

CREATE INDEX idx_queries_request_id ON queries(request_id);
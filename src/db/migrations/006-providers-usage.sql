-- Provider connections + model tiers (docs/12): per-call usage detail in the
-- thread log, and a per-connection daily request counter (free-model limits).

ALTER TABLE thread_log ADD COLUMN connection_id TEXT;
ALTER TABLE thread_log ADD COLUMN cache_read INTEGER;
ALTER TABLE thread_log ADD COLUMN cache_write INTEGER;
ALTER TABLE thread_log ADD COLUMN reasoning_tokens INTEGER;
ALTER TABLE thread_log ADD COLUMN cost REAL;

CREATE TABLE request_counts (
  connection_id TEXT NOT NULL,
  day           TEXT NOT NULL,             -- UTC date, YYYY-MM-DD
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (connection_id, day)
);

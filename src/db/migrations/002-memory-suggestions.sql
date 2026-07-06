-- Layer 3b: the suggestion inbox (fuzzy merges / contradictions the scribe or
-- maintenance job flags for human review). Auto-merges never land here.

CREATE TABLE memory_suggestions (
  id         TEXT PRIMARY KEY,
  story_id   TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,                 -- merge | contradiction
  keep_id    TEXT,                          -- object/fact to keep
  merge_id   TEXT,                          -- object/fact to fold in (merge)
  reason     TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_suggestions_story ON memory_suggestions(story_id, status);

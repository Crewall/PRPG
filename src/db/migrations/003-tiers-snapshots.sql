-- Feature pack: fact importance tiers + pre-turn state snapshots (rewind/edit).

-- Tier: how prominent a fact is (major = conspicuous defining features,
-- mid = surfaces when thinking about / focusing on the object,
-- minor = nuances that only appear under close inspection).
ALTER TABLE memory_facts ADD COLUMN tier TEXT NOT NULL DEFAULT 'mid';

-- One snapshot per turn of everything mutable a turn (and its post-turn
-- scribes) can change, captured BEFORE the turn runs. Restoring it and
-- deleting the turn rewinds the story to the moment the message was sent.
CREATE TABLE turn_snapshots (
  turn_id      TEXT PRIMARY KEY,
  story_id     TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  turn_index   INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_snapshots_story ON turn_snapshots(story_id, turn_index);

-- Minds engine (docs/11 §4.9): which characters have met (been present in the same
-- round), so relation variables exist per pair who have met. One row per pair, a < b.
CREATE TABLE character_met (
  story_id      TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  a             TEXT NOT NULL,
  b             TEXT NOT NULL,
  first_turn_id TEXT,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (a, b)
);
CREATE INDEX idx_met_story ON character_met(story_id);

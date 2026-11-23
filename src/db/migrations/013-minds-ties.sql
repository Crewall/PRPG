-- Minds engine (docs/11 §2.3, §2.6): the narrator's hand-over and ties.
-- The narrator's 1–3 sentences of fact about a newcomer (who they are, why here): its identity until the seeder's
-- description lands, and canon for the seeder.
ALTER TABLE character_sheets ADD COLUMN concept TEXT NOT NULL DEFAULT '';
-- How one character relates to another, from the holder's side ("older sibling").
CREATE TABLE character_ties (
  story_id        TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  holder          TEXT NOT NULL,
  other           TEXT NOT NULL,
  label           TEXT NOT NULL,
  created_turn_id TEXT,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (holder, other)
);
CREATE INDEX idx_ties_story ON character_ties(story_id);

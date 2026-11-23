-- Minds engine (docs/11 §2.5): names — who knows whom.
-- How someone who doesn't know a character's name refers to them ("the elf girl in green").
ALTER TABLE character_sheets ADD COLUMN known_as TEXT NOT NULL DEFAULT '';
-- viewer knows subject's name (viewer: a character's object id; the player character's id for the player).
CREATE TABLE name_knowledge (
  story_id        TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  viewer          TEXT NOT NULL,
  subject         TEXT NOT NULL,
  learned_turn_id TEXT,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (viewer, subject)
);
CREATE INDEX idx_names_story ON name_knowledge(story_id);

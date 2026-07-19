-- NPC Story Mode (docs/09-npc-story-mode.md): each major NPC's mind as a
-- narrative document — a stable personality plus evolving private notes —
-- replacing the structured fact pipeline when the mode is enabled.
CREATE TABLE npc_profiles (
  object_id   TEXT PRIMARY KEY REFERENCES memory_objects(id) ON DELETE CASCADE,
  story_id    TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  personality TEXT NOT NULL DEFAULT '',   -- stable: temperament, voice, manner, drives
  notes       TEXT NOT NULL DEFAULT '',   -- evolving private notes, brief factual bullets
  last_present_turn_idx INTEGER NOT NULL DEFAULT -1,
  last_acted_turn_idx   INTEGER NOT NULL DEFAULT -1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_npc_profiles_story ON npc_profiles(story_id);

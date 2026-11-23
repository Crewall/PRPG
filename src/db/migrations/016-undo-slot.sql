-- One undo step per story (docs/10 §10a): the full state saved right before a
-- destructive action (regenerate, Edit, remove or edit of the last exchange),
-- restored exactly by Revert. A new message or a new destructive action replaces it.
CREATE TABLE undo_slots (
  story_id     TEXT PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,
  action       TEXT NOT NULL,      -- regenerate | rewind | remove | edit-reply | edit-text | remove-text
  label        TEXT NOT NULL,      -- what Revert says ("Bring back the previous reply")
  from_index   INTEGER NOT NULL,   -- the first turn index the action touched
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

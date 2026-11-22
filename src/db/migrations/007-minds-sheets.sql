-- Minds engine, milestone M2 (docs/11): character sheets, scenario variables
-- with a change log, self-written thoughts, and roster handles.

-- Short, unique-per-story id for every roster object ("marta" → shown as #marta).
ALTER TABLE memory_objects ADD COLUMN handle TEXT;
CREATE UNIQUE INDEX idx_objects_handle ON memory_objects(story_id, handle) WHERE handle IS NOT NULL;

CREATE TABLE character_sheets (
  object_id   TEXT PRIMARY KEY REFERENCES memory_objects(id) ON DELETE CASCADE,
  story_id    TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  is_player   INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',   -- private: who they are (the holder's system prompt)
  appearance  TEXT NOT NULL DEFAULT '',   -- public: what anyone sees
  state       TEXT NOT NULL DEFAULT '',   -- one sentence: emotional and/or physical condition
  tier_id     TEXT,                       -- per-character model tier override (docs/12)
  seeded      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_sheets_story ON character_sheets(story_id);

-- One row per scenario variable; the definition itself is Zod-validated JSON
-- (its shape differs per type: number / text / choice / flag / list).
CREATE TABLE variable_defs (
  id         TEXT PRIMARY KEY,
  story_id   TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  def_json   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (story_id, key)
);

CREATE TABLE variable_values (
  story_id        TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  def_key         TEXT NOT NULL,
  holder          TEXT NOT NULL,          -- character object id, or 'world'
  value_json      TEXT NOT NULL,
  updated_turn_id TEXT,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (story_id, def_key, holder)
);

-- Append-only: every attempted change (also '$state'), applied or not.
CREATE TABLE variable_changes (
  id         TEXT PRIMARY KEY,
  story_id   TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  turn_id    TEXT,
  holder     TEXT NOT NULL,
  def_key    TEXT NOT NULL,
  old_json   TEXT,
  new_json   TEXT,
  op_json    TEXT NOT NULL,
  by         TEXT NOT NULL,               -- narrator | self | user | seed | system
  result     TEXT NOT NULL,               -- applied | clamped | rejected | overridden
  reason     TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_varchanges_story ON variable_changes(story_id, holder);

CREATE TABLE thoughts (
  id                    TEXT PRIMARY KEY,
  story_id              TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  owner                 TEXT NOT NULL,     -- character object id, or 'narrator'
  seq                   INTEGER NOT NULL,  -- per owner: shown to the model as t<seq>
  text                  TEXT NOT NULL,
  pinned                INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'active',   -- active | revoked
  source                TEXT NOT NULL,                    -- self | seed | compactor | user
  created_turn_id       TEXT,
  revoked_turn_id       TEXT,
  last_recalled_turn_id TEXT,
  recall_count          INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  UNIQUE (story_id, owner, seq)
);
CREATE INDEX idx_thoughts_owner ON thoughts(story_id, owner, status);

CREATE TABLE thought_tags (
  thought_id TEXT NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  PRIMARY KEY (thought_id, tag)
);
CREATE INDEX idx_thought_tags_tag ON thought_tags(tag);

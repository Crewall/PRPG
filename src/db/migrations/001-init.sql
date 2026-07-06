-- PRPG initial schema. All tables from docs/03-data-model.md.
-- Every table carries created_at / updated_at (unix ms). IDs are short strings.
-- NOTE: the design doc calls the ordinal column "index"; it is a SQLite keyword,
-- so it is stored as `idx` and exposed as `index` by the store layer.

CREATE TABLE stories (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  settings_json    TEXT NOT NULL,           -- StorySettings (Zod-validated)
  current_scene_id TEXT,
  status           TEXT NOT NULL DEFAULT 'active',  -- active | archived
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE scenes (
  id                 TEXT PRIMARY KEY,
  story_id           TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  idx                INTEGER NOT NULL,       -- "index": per story
  title              TEXT,
  location_object_id TEXT,                   -- FK -> memory_objects (nullable)
  active_npc_ids     TEXT NOT NULL DEFAULT '[]',  -- JSON array of memory_object ids
  status             TEXT NOT NULL DEFAULT 'open', -- open | closed
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX idx_scenes_story ON scenes(story_id);

CREATE TABLE turns (
  id           TEXT PRIMARY KEY,
  story_id     TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  scene_id     TEXT REFERENCES scenes(id) ON DELETE SET NULL,
  idx          INTEGER NOT NULL,             -- "index": per story, monotonic
  player_input TEXT NOT NULL,
  narration    TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'streaming', -- streaming | complete | rejected | error
  meta_json    TEXT NOT NULL DEFAULT '{}',   -- token counts, regen count, verdicts, timings
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_turns_story ON turns(story_id, idx);

CREATE TABLE agent_sessions (
  id            TEXT PRIMARY KEY,
  story_id      TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,               -- storyteller | npc | scribe_memory | scribe_story | overseer
  npc_object_id TEXT,                         -- FK -> memory_objects; only for role=npc
  model_profile TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'active', -- active | dormant | closed
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_sessions_story_role ON agent_sessions(story_id, role);

CREATE TABLE agent_messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  turn_id    TEXT,                            -- nullable (bootstrap msgs)
  role       TEXT NOT NULL,                   -- system | user | assistant
  content    TEXT NOT NULL,
  pinned     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_session ON agent_messages(session_id, created_at);

CREATE TABLE memory_objects (
  id           TEXT PRIMARY KEY,
  story_id     TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,                 -- character | item | location | faction | event | lore
  name         TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  summary      TEXT NOT NULL DEFAULT '',
  salience     REAL NOT NULL DEFAULT 0.5,     -- 0..1
  status       TEXT NOT NULL DEFAULT 'active',-- active | dormant | destroyed/dead
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_objects_story ON memory_objects(story_id);

CREATE TABLE memory_facts (
  id             TEXT PRIMARY KEY,
  object_id      TEXT NOT NULL REFERENCES memory_objects(id) ON DELETE CASCADE,
  category       TEXT NOT NULL,
  subcategory    TEXT,
  detail_level   TEXT NOT NULL,               -- visible | known | secret | hidden
  content        TEXT NOT NULL,
  source_turn_id TEXT,
  supersedes_id  TEXT,
  superseded     INTEGER NOT NULL DEFAULT 0,
  confidence     REAL NOT NULL DEFAULT 1.0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_facts_object ON memory_facts(object_id);

-- Full-text index over fact content + object name/aliases, kept in sync by triggers.
CREATE VIRTUAL TABLE memory_fts USING fts5(
  content,
  object_id UNINDEXED,
  fact_id UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TRIGGER memory_facts_ai AFTER INSERT ON memory_facts BEGIN
  INSERT INTO memory_fts (rowid, content, object_id, fact_id)
  VALUES (new.rowid, new.content, new.object_id, new.id);
END;
CREATE TRIGGER memory_facts_ad AFTER DELETE ON memory_facts BEGIN
  DELETE FROM memory_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER memory_facts_au AFTER UPDATE ON memory_facts BEGIN
  DELETE FROM memory_fts WHERE rowid = old.rowid;
  INSERT INTO memory_fts (rowid, content, object_id, fact_id)
  VALUES (new.rowid, new.content, new.object_id, new.id);
END;

CREATE TABLE knowledge_links (
  id                    TEXT PRIMARY KEY,
  fact_id               TEXT NOT NULL REFERENCES memory_facts(id) ON DELETE CASCADE,
  knower_type           TEXT NOT NULL,        -- player | npc
  knower_npc_object_id  TEXT,                 -- when knower_type=npc
  learned_turn_id       TEXT,
  distortion            TEXT,                 -- what this knower wrongly believes instead
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX idx_klinks_fact ON knowledge_links(fact_id);

CREATE TABLE story_summaries (
  id                   TEXT PRIMARY KEY,
  story_id             TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  scope                TEXT NOT NULL,          -- scene | story
  scene_id             TEXT,
  content              TEXT NOT NULL DEFAULT '',
  covers_to_turn_index INTEGER NOT NULL DEFAULT -1,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX idx_summaries_story ON story_summaries(story_id, scope);

CREATE TABLE rules (
  id         TEXT PRIMARY KEY,
  story_id   TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  scope      TEXT NOT NULL,                    -- story | npc:<object_id> | world
  text       TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'soft',     -- hard | soft
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_rules_story ON rules(story_id);

CREATE TABLE thread_log (
  id         TEXT PRIMARY KEY,
  story_id   TEXT,
  turn_id    TEXT,
  session_id TEXT,
  agent_role TEXT NOT NULL,
  direction  TEXT NOT NULL,                    -- request | response
  payload_json TEXT NOT NULL,
  tokens_in  INTEGER,
  tokens_out INTEGER,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_threadlog_story ON thread_log(story_id, created_at);
CREATE INDEX idx_threadlog_turn ON thread_log(turn_id);

CREATE TABLE jobs (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,                  -- scribe_memory | scribe_story
  story_id     TEXT,
  turn_id      TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',-- pending | running | done | failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_jobs_status ON jobs(status);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

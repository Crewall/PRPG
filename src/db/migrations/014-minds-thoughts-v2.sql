-- Minds engine (docs/11 §5.6–5.8): thoughts get a kind, an importance that fades,
-- a subject, and revision history. Older thoughts become notes of importance 5.
ALTER TABLE thoughts ADD COLUMN kind TEXT NOT NULL DEFAULT 'note';        -- agenda | opinion | feeling | note
ALTER TABLE thoughts ADD COLUMN importance INTEGER NOT NULL DEFAULT 5;    -- 1–10, as written
ALTER TABLE thoughts ADD COLUMN about TEXT;                               -- object id it is about
ALTER TABLE thoughts ADD COLUMN renewed_clock_min INTEGER;                -- written, revised or last came up
ALTER TABLE thoughts ADD COLUMN revises TEXT;                             -- the thought this one replaced
ALTER TABLE thoughts ADD COLUMN status_turn_id TEXT;                      -- the turn it faded or was revised
UPDATE thoughts SET renewed_clock_min = created_clock_min;

-- Minds engine (docs/11 §2.7, §5.7, §5.11): the character's nature, fading by
-- rounds as well as hours, and expectations.
ALTER TABLE character_sheets ADD COLUMN nature TEXT NOT NULL DEFAULT '';
ALTER TABLE thoughts ADD COLUMN renewed_turn_index INTEGER;   -- the round it was written, revised or last came up
ALTER TABLE thoughts ADD COLUMN confidence INTEGER;           -- expectations: how sure, 1–10
ALTER TABLE thoughts ADD COLUMN hope TEXT;                    -- expectations: hope | fear | neutral
ALTER TABLE thoughts ADD COLUMN horizon TEXT;                 -- expectations: soon | today | later
ALTER TABLE thoughts ADD COLUMN basis TEXT;                   -- expectations: the thought it comes from
UPDATE thoughts SET renewed_turn_index = (SELECT idx FROM turns WHERE turns.id = thoughts.created_turn_id);

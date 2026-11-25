-- Minds engine (docs/10 §5.1f): whether a character can perceive. awake | asleep | unconscious. Someone who isn't
-- awake is never called, hears nothing and gets no brief.
ALTER TABLE character_sheets ADD COLUMN awareness TEXT NOT NULL DEFAULT 'awake';

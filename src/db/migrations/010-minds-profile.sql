-- Minds engine (docs/11 §2.4, §5.2): the public profile and thought times.
-- Pronouns are public, shown with the name wherever others see the character.
ALTER TABLE character_sheets ADD COLUMN pronouns TEXT NOT NULL DEFAULT '';
-- The in-story time a thought was written (minutes on the game clock).
ALTER TABLE thoughts ADD COLUMN created_clock_min INTEGER;

-- Hidden in-game clock. Stories start at Day 1, 08:00 (minute 480); the
-- storyteller advances it via the advance_time directive (default: a few
-- minutes per exchange). Memory facts are stamped with the clock at the moment
-- they were recorded, so events carry an in-fiction "when".
ALTER TABLE stories ADD COLUMN clock_min INTEGER NOT NULL DEFAULT 480;
ALTER TABLE memory_facts ADD COLUMN game_time_min INTEGER;

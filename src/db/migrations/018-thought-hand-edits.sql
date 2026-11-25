-- Minds engine (docs/11 §5.10c): your hand edits of a mind. When a thought was last changed by hand (a rewind
-- keeps a newer hand edit over the saved copy; a thought forgotten by hand stays forgotten), and the wording it had
-- before your last edit (a mind restating that wording renews the edited thought instead of adding the old one).
ALTER TABLE thoughts ADD COLUMN user_edited_at INTEGER;
ALTER TABLE thoughts ADD COLUMN former_text TEXT;

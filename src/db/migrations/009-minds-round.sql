-- Minds engine, milestone M4 (docs/10 §9.3): the narrator's scene.items — the
-- roster handles of things in view, shown on each character's "Here:" line.
ALTER TABLE scenes ADD COLUMN items_json TEXT NOT NULL DEFAULT '[]';

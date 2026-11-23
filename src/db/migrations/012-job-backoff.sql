-- Background jobs back off between attempts (a provider overload or rate limit
-- needs time, not three tries within a second).
ALTER TABLE jobs ADD COLUMN not_before INTEGER;

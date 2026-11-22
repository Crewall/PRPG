-- Minds engine, milestone M3 (docs/10 §8): agent_messages become real,
-- append-only threads that are read back.
--   kind: 'log'       — a round message or reply, stored exactly as sent/received
--         'pending'   — text waiting to be delivered in the next round message
--                       (briefs, heard lines, notes)
--         'delivered' — a pending item already folded into a round message
--         'recap'     — the current compaction recap (M6); 'recap_old' when replaced
--   compacted: 1 when a log row has been folded into a recap (M6)

ALTER TABLE agent_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'log';
ALTER TABLE agent_messages ADD COLUMN compacted INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_messages_session_kind ON agent_messages(session_id, kind, compacted);

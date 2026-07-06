import { describe, it, expect } from 'vitest';
import { openDb, migrate } from '../src/db/db.ts';

describe('database migrations', () => {
  it('creates every core table on a fresh db', () => {
    const db = openDb(':memory:');
    const applied = migrate(db);
    expect(applied).toContain('001-init.sql');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all<{ name: string }>()
      .map((r) => r.name);
    for (const t of ['stories', 'scenes', 'turns', 'agent_sessions', 'agent_messages', 'memory_objects', 'memory_facts', 'knowledge_links', 'story_summaries', 'rules', 'thread_log', 'jobs', 'settings']) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  it('is idempotent — re-running applies nothing new', () => {
    const db = openDb(':memory:');
    const first = migrate(db);
    expect(first.length).toBeGreaterThan(0);
    const second = migrate(db);
    expect(second).toEqual([]);
    db.close();
  });

  it('keeps the FTS index in sync with memory_facts via triggers', () => {
    const db = openDb(':memory:');
    migrate(db);
    const now = Date.now();
    db.prepare(`INSERT INTO stories (id, title, settings_json, status, created_at, updated_at) VALUES ('s1','t','{}','active',?,?)`).run(now, now);
    db.prepare(`INSERT INTO memory_objects (id, story_id, type, name, created_at, updated_at) VALUES ('o1','s1','character','Marta',?,?)`).run(now, now);
    db.prepare(`INSERT INTO memory_facts (id, object_id, category, detail_level, content, created_at, updated_at) VALUES ('f1','o1','history','secret','Marta hid the stolen ledger in the cellar',?,?)`).run(now, now);

    const hit = db.prepare(`SELECT fact_id FROM memory_fts WHERE memory_fts MATCH 'ledger'`).get<{ fact_id: string }>();
    expect(hit?.fact_id).toBe('f1');

    // Delete should remove it from the index.
    db.prepare(`DELETE FROM memory_facts WHERE id='f1'`).run();
    const gone = db.prepare(`SELECT fact_id FROM memory_fts WHERE memory_fts MATCH 'ledger'`).get();
    expect(gone).toBeUndefined();
    db.close();
  });

  it('rolls back a failing transaction', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() =>
      db.transaction(() => {
        db.prepare(`INSERT INTO settings (key, value_json, created_at, updated_at) VALUES ('k','1',0,0)`).run();
        throw new Error('boom');
      }),
    ).toThrow('boom');
    const r = db.prepare(`SELECT value_json FROM settings WHERE key='k'`).get();
    expect(r).toBeUndefined();
    db.close();
  });
});

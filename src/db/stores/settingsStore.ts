import type { Db, Row } from '../db.ts';

// Global key-value runtime settings, editable from the UI without touching
// config.json (debug visibility, retention, default budgets).
export function createSettingsStore(db: Db) {
  return {
    get<T = unknown>(key: string, fallback: T): T {
      const r = db.prepare(`SELECT value_json FROM settings WHERE key = ?`).get<Row>(key);
      if (!r) return fallback;
      try {
        return JSON.parse(r.value_json as string) as T;
      } catch {
        return fallback;
      }
    },

    set(key: string, value: unknown): void {
      const now = Date.now();
      db.prepare(
        `INSERT INTO settings (key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      ).run(key, JSON.stringify(value), now, now);
    },

    all(): Record<string, unknown> {
      const rows = db.prepare(`SELECT key, value_json FROM settings`).all<Row>();
      const out: Record<string, unknown> = {};
      for (const r of rows) {
        try {
          out[r.key as string] = JSON.parse(r.value_json as string);
        } catch {
          /* skip malformed */
        }
      }
      return out;
    },
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;

import type { Db, Row } from '../db.ts';

// Requests per provider connection per UTC day (docs/12 §6.1): makes free-model
// daily limits visible before they start failing calls.

/** Today's date in UTC as YYYY-MM-DD (providers reset daily limits on UTC days). */
export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function createUsageStore(db: Db) {
  return {
    /** Count one model call on a connection. */
    increment(connectionId: string, day = utcDay()): void {
      db.prepare(
        `INSERT INTO request_counts (connection_id, day, count) VALUES (?, ?, 1)
         ON CONFLICT(connection_id, day) DO UPDATE SET count = count + 1`,
      ).run(connectionId, day);
    },

    /** Requests per connection on one day. */
    countsFor(day = utcDay()): Record<string, number> {
      const out: Record<string, number> = {};
      for (const r of db.prepare(`SELECT connection_id, count FROM request_counts WHERE day = ?`).all<Row>(day)) {
        out[r.connection_id as string] = r.count as number;
      }
      return out;
    },
  };
}

export type UsageStore = ReturnType<typeof createUsageStore>;

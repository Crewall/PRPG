import type { Db, Row } from '../db.ts';
import { id } from '../../util/id.ts';

export type JobType = 'scribe_story' | 'scribe_memory' | 'memory_maintenance' | 'archive_faded';
export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  type: JobType;
  storyId: string | null;
  turnId: string | null;
  status: JobStatus;
  attempts: number;
  payload: Record<string, unknown>;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

function rowToJob(r: Row): Job {
  return {
    id: r.id as string,
    type: r.type as JobType,
    storyId: (r.story_id as string) ?? null,
    turnId: (r.turn_id as string) ?? null,
    status: r.status as JobStatus,
    attempts: r.attempts as number,
    payload: JSON.parse((r.payload_json as string) || '{}'),
    lastError: (r.last_error as string) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

// Persistent queue table backing the post-turn scribe workers. Crash-safe:
// requeueStuck() on boot moves orphaned 'running' jobs back to 'pending'.
export function createJobStore(db: Db) {
  return {
    enqueue(type: JobType, opts: { storyId?: string | null; turnId?: string | null; payload?: Record<string, unknown> } = {}): Job {
      const now = Date.now();
      const jid = id();
      db.prepare(
        `INSERT INTO jobs (id, type, story_id, turn_id, status, attempts, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      ).run(jid, type, opts.storyId ?? null, opts.turnId ?? null, JSON.stringify(opts.payload ?? {}), now, now);
      return this.get(jid)!;
    },

    get(jobId: string): Job | undefined {
      const r = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get<Row>(jobId);
      return r ? rowToJob(r) : undefined;
    },

    /** Atomically claim the next pending job (oldest first), marking it running. */
    claimNext(): Job | undefined {
      return db.transaction(() => {
        const r = db.prepare(`SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`).get<Row>();
        if (!r) return undefined;
        const job = rowToJob(r);
        db.prepare(`UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?`).run(Date.now(), job.id);
        return { ...job, status: 'running' as JobStatus, attempts: job.attempts + 1 };
      });
    },

    markDone(jobId: string): void {
      db.prepare(`UPDATE jobs SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?`).run(Date.now(), jobId);
    },

    /** Record a failure; requeue as pending unless attempts exhausted (then failed). */
    markFailedOrRetry(jobId: string, error: string, maxAttempts = 3): JobStatus {
      const job = this.get(jobId);
      if (!job) return 'failed';
      const status: JobStatus = job.attempts >= maxAttempts ? 'failed' : 'pending';
      db.prepare(`UPDATE jobs SET status = ?, last_error = ?, updated_at = ? WHERE id = ?`).run(status, error.slice(0, 1000), Date.now(), jobId);
      return status;
    },

    retry(jobId: string): void {
      db.prepare(`UPDATE jobs SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'failed'`).run(Date.now(), jobId);
    },

    countPending(): number {
      return (db.prepare(`SELECT count(*) AS n FROM jobs WHERE status IN ('pending','running')`).get<{ n: number }>()!).n;
    },

    listFailed(storyId?: string): Job[] {
      const rows = storyId
        ? db.prepare(`SELECT * FROM jobs WHERE status = 'failed' AND story_id = ? ORDER BY updated_at DESC`).all<Row>(storyId)
        : db.prepare(`SELECT * FROM jobs WHERE status = 'failed' ORDER BY updated_at DESC`).all<Row>();
      return rows.map(rowToJob);
    },

    /** On boot, move interrupted 'running' jobs back to 'pending' so they re-run. */
    requeueStuck(): number {
      const res = db.prepare(`UPDATE jobs SET status = 'pending', updated_at = ? WHERE status = 'running'`).run(Date.now());
      return Number(res.changes);
    },
  };
}

export type JobStore = ReturnType<typeof createJobStore>;

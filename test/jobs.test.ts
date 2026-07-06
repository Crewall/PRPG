import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, migrate } from '../src/db/db.ts';
import type { Db } from '../src/db/db.ts';
import { createJobStore } from '../src/db/stores/jobStore.ts';
import { JobWorker } from '../src/orchestrator/postTurn.ts';
import { EventBus } from '../src/util/events.ts';
import type { ServerEvent } from '../src/util/events.ts';

describe('job queue + worker (Layer 2)', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });
  afterEach(() => db.close());

  it('drains pending jobs through the registered handler', async () => {
    const jobs = createJobStore(db);
    const worker = new JobWorker(jobs, new EventBus());
    const seen: string[] = [];
    worker.register('scribe_story', async (job) => {
      seen.push(job.payload.tag as string);
    });
    jobs.enqueue('scribe_story', { payload: { tag: 'a' } });
    jobs.enqueue('scribe_story', { payload: { tag: 'b' } });
    await worker.drain();
    expect(seen).toEqual(['a', 'b']);
    expect(jobs.countPending()).toBe(0);
  });

  it('retries a failing job up to maxAttempts then marks it failed + emits event', async () => {
    const jobs = createJobStore(db);
    const events = new EventBus();
    const captured: ServerEvent[] = [];
    events.on((e) => captured.push(e));
    const worker = new JobWorker(jobs, events, { maxAttempts: 3 });
    let attempts = 0;
    worker.register('scribe_memory', async () => {
      attempts++;
      throw new Error('boom');
    });
    const job = jobs.enqueue('scribe_memory', { storyId: 's1' });
    await worker.drain(); // drain re-picks pending after each retry until failed
    expect(attempts).toBe(3);
    expect(jobs.get(job.id)!.status).toBe('failed');
    expect(captured.some((e) => e.t === 'job.failed')).toBe(true);
  });

  it('requeues interrupted (running) jobs on boot — crash safety', () => {
    const jobs = createJobStore(db);
    const job = jobs.enqueue('scribe_story', {});
    jobs.claimNext(); // now 'running'
    expect(jobs.get(job.id)!.status).toBe('running');
    // Simulate a restart.
    const requeued = jobs.requeueStuck();
    expect(requeued).toBe(1);
    expect(jobs.get(job.id)!.status).toBe('pending');
  });

  it('a failed job can be retried from the UI/API', async () => {
    const jobs = createJobStore(db);
    const worker = new JobWorker(jobs, new EventBus(), { maxAttempts: 1 });
    let shouldFail = true;
    worker.register('scribe_story', async () => {
      if (shouldFail) throw new Error('nope');
    });
    const job = jobs.enqueue('scribe_story', {});
    await worker.drain();
    expect(jobs.get(job.id)!.status).toBe('failed');
    shouldFail = false;
    jobs.retry(job.id);
    await worker.drain();
    expect(jobs.get(job.id)!.status).toBe('done');
  });
});

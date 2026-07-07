import type { JobStore, Job, JobType } from '../db/stores/jobStore.ts';
import type { EventBus } from '../util/events.ts';
import { logger } from '../util/logger.ts';

export type JobHandler = (job: Job) => Promise<void>;

/**
 * In-process job worker draining the persistent `jobs` queue (06-orchestration.md).
 * - concurrency 2, FIFO by creation time,
 * - retries ×maxAttempts (backoff via poll interval), then `failed` + event,
 * - crash-safe: requeueStuck() on start re-queues interrupted 'running' jobs.
 * The player path never awaits this — scribes lag, they do not block.
 */
export class JobWorker {
  private readonly jobs: JobStore;
  private readonly events: EventBus;
  private readonly handlers = new Map<JobType, JobHandler>();
  private readonly maxAttempts: number;
  private readonly concurrency: number;
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = 0;

  constructor(jobs: JobStore, events: EventBus, opts: { maxAttempts?: number; concurrency?: number; pollMs?: number } = {}) {
    this.jobs = jobs;
    this.events = events;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.concurrency = opts.concurrency ?? 2;
    this.pollMs = opts.pollMs ?? 250;
  }

  register(type: JobType, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  /** Begin background draining. Requeues interrupted jobs first (crash safety). */
  start(): void {
    const requeued = this.jobs.requeueStuck();
    if (requeued) logger.info('requeued interrupted jobs on boot', { count: requeued });
    if (this.timer) return;
    this.timer = setInterval(() => this.pump(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      const job = this.jobs.claimNext();
      if (!job) break;
      this.active++;
      void this.runJob(job).finally(() => {
        this.active--;
      });
    }
  }

  /** Synchronously drain the queue to empty (used by tests). Sequential. */
  async drain(): Promise<void> {
    for (;;) {
      const job = this.jobs.claimNext();
      if (!job) return;
      await this.runJob(job);
    }
  }

  private async runJob(job: Job): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      logger.warn('no handler for job type', { type: job.type, jobId: job.id });
      this.jobs.markFailedOrRetry(job.id, `no handler for '${job.type}'`, 0);
      return;
    }
    try {
      await handler(job);
      this.jobs.markDone(job.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = this.jobs.markFailedOrRetry(job.id, message, this.maxAttempts);
      logger.warn('job failed', { type: job.type, jobId: job.id, attempt: job.attempts, status, message });
      if (status === 'failed') {
        this.events.emit({ t: 'job.failed', storyId: job.storyId, jobId: job.id, type: job.type, error: message });
      }
    }
  }
}

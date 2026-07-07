import { EventEmitter } from 'node:events';

// Server-side event bus. The orchestrator/jobs emit these; the WS layer forwards
// them to connected clients (06-orchestration.md WS protocol: memory.updated,
// summary.updated, job.failed, thread.activity).
export type ServerEvent =
  | { t: 'summary.updated'; storyId: string; scope: 'scene' | 'story' }
  | { t: 'memory.updated'; storyId: string; objectIds: string[] }
  | { t: 'job.failed'; storyId: string | null; jobId: string; type: string; error: string }
  | { t: 'scene.changed'; storyId: string; sceneId: string }
  | { t: 'story.rewound'; storyId: string; turnId: string; playerInput: string }
  | { t: 'thread.activity'; storyId: string | null; entry: unknown };

export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit(event: ServerEvent): void {
    this.emitter.emit('event', event);
  }

  on(listener: (event: ServerEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}

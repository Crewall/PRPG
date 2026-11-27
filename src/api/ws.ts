import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { App } from '../app.ts';
import type { TurnEmitter } from '../orchestrator/turnPipeline.ts';
import type { Turn } from '../domain.ts';
import { logger } from '../util/logger.ts';

const ClientMsg = z.discriminatedUnion('t', [
  z.object({ t: z.literal('turn.submit'), storyId: z.string(), input: z.string(), force: z.array(z.string()).optional(), floor: z.array(z.string()).optional(), dialogue: z.object({ partner: z.string() }).optional(), review: z.boolean().optional() }),
  z.object({ t: z.literal('turn.cancel'), storyId: z.string() }),
  // Retry the story's last turn (a failed attempt, or a reply to write again); turnId = the one the client means.
  // Regenerate a turn (default: the last one); lastTurnId = the story's last turn as the client knows it.
  z.object({ t: z.literal('turn.retry'), storyId: z.string(), turnId: z.string().optional(), lastTurnId: z.string().optional(), review: z.boolean().optional() }),
]);

// WebSocket endpoint at /ws. Protocol per 06-orchestration.md (Layer-1 subset:
// submit / status / delta / final / rejected / cancel).
export async function registerWsRoutes(server: FastifyInstance, app: App): Promise<void> {
  server.get('/ws', { websocket: true }, (socket) => {
    const send = (obj: unknown) => {
      try {
        socket.send(JSON.stringify(obj));
      } catch (err) {
        logger.warn('ws send failed', { err: (err as Error).message });
      }
    };

    // Forward server-side events (summaries, memory, jobs) to this client.
    const unsubscribe = app.events.on((event) => send(event));
    socket.on('close', () => unsubscribe());

    socket.on('message', (raw: Buffer) => {
      let parsed;
      try {
        parsed = ClientMsg.parse(JSON.parse(raw.toString()));
      } catch (err) {
        send({ t: 'error', message: `bad message: ${(err as Error).message}` });
        return;
      }

      if (parsed.t === 'turn.cancel') {
        app.pipeline.cancel(parsed.storyId);
        return;
      }

      // turn.submit / turn.retry — drive the pipeline, forwarding events over the socket.
      const emitter: TurnEmitter = {
        accepted: (turnId: string) => send({ t: 'turn.accepted', turnId }),
        status: (text: string) => send({ t: 'turn.status', text }),
        delta: (text: string) => send({ t: 'turn.delta', text }),
        final: (turn: Turn) => send({ t: 'turn.final', turnId: turn.id, narration: turn.narration, status: turn.status, meta: turn.meta }),
        rejected: (turnId: string, reason: string) => send({ t: 'turn.rejected', turnId, reason }),
        error: (turnId: string, message: string) => send({ t: 'turn.error', turnId, message }),
      };

      const running =
        parsed.t === 'turn.retry'
          ? app.pipeline.retry(parsed.storyId, emitter, { turnId: parsed.turnId, expectTurnId: parsed.lastTurnId ?? parsed.turnId, review: parsed.review })
          : app.pipeline.run(parsed.storyId, parsed.input, emitter, { force: parsed.force, floor: parsed.floor, dialogue: parsed.dialogue, review: parsed.review });
      running.catch((err) => {
        send({ t: 'turn.error', message: (err as Error).message });
      });
    });
  });
}

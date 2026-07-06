import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { App } from '../app.ts';
import type { TurnEmitter } from '../orchestrator/turnPipeline.ts';
import type { Turn } from '../domain.ts';
import { logger } from '../util/logger.ts';

const ClientMsg = z.discriminatedUnion('t', [
  z.object({ t: z.literal('turn.submit'), storyId: z.string(), input: z.string() }),
  z.object({ t: z.literal('turn.cancel'), storyId: z.string() }),
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

      // turn.submit — drive the pipeline, forwarding events over the socket.
      const emitter: TurnEmitter = {
        accepted: (turnId: string) => send({ t: 'turn.accepted', turnId }),
        status: (text: string) => send({ t: 'turn.status', text }),
        delta: (text: string) => send({ t: 'turn.delta', text }),
        final: (turn: Turn) => send({ t: 'turn.final', turnId: turn.id, narration: turn.narration, meta: turn.meta }),
        rejected: (turnId: string, reason: string) => send({ t: 'turn.rejected', turnId, reason }),
        error: (turnId: string, message: string) => send({ t: 'turn.error', turnId, message }),
      };

      app.pipeline.run(parsed.storyId, parsed.input, emitter).catch((err) => {
        send({ t: 'turn.error', message: (err as Error).message });
      });
    });
  });
}

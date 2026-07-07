import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, ConfigError } from './config/config.ts';
import { createApp } from './app.ts';
import { registerHttpRoutes } from './api/http.ts';
import { registerWsRoutes } from './api/ws.ts';
import { logger } from './util/logger.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_DIR = join(ROOT, 'client', 'dist');

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env.PRPG_CONFIG ?? 'config.json');
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const app = createApp(config);
  const server = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });

  // Optional shared-token auth for LAN exposure (config.server.token).
  if (config.server.token) {
    server.addHook('onRequest', async (req, reply) => {
      if (req.url === '/api/system/health') return;
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${config.server.token}`) {
        reply.code(401).send({ error: 'unauthorized' });
      }
    });
  }

  await server.register(fastifyWebsocket);
  await registerHttpRoutes(server, app);
  await registerWsRoutes(server, app);

  // Serve the built static client (no build step on the phone — see 01-tech-stack.md).
  if (existsSync(CLIENT_DIR)) {
    // no-cache: the client has no build/version step, so stale browser caches
    // (especially on phones) would keep serving an old UI after an update.
    // Files are tiny; ETag revalidation keeps reloads cheap.
    await server.register(fastifyStatic, {
      root: CLIENT_DIR,
      prefix: '/',
      cacheControl: false,
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
    });
    // SPA fallback: unmatched non-API routes serve index.html.
    server.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
        reply.code(404).send({ error: 'not found' });
        return;
      }
      reply.sendFile('index.html');
    });
  } else {
    logger.warn('client/dist not found — API only (no web UI served)', { clientDir: CLIENT_DIR });
  }

  try {
    await server.listen({ host: config.server.host, port: config.server.port });
    logger.info('PRPG server listening', { host: config.server.host, port: config.server.port });
    console.log(`\n  PRPG running → http://${config.server.host}:${config.server.port}\n`);
  } catch (err) {
    logger.error('failed to start server', { err });
    process.exit(1);
  }

  const shutdown = async () => {
    logger.info('shutting down');
    await server.close();
    app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('fatal', { err });
  console.error(err);
  process.exit(1);
});

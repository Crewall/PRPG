import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { createVersionInfo, fingerprint, gitCommit } from '../src/util/version.ts';
import { registerHttpRoutes } from '../src/api/http.ts';
import { mindsHarness } from './fixtures/minds.ts';

// The version check (docs/10 §11.2): after an update, is the server running the code on disk, and have the client
// files changed since a page loaded them?

describe('version check', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });
  const tree = () => {
    root = mkdtempSync(join(tmpdir(), 'prpg-version-'));
    for (const d of ['src/api', 'client/dist', 'src/node_modules/x', '.git/refs/heads']) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, 'src/api/http.ts'), 'export {};\n');
    writeFileSync(join(root, 'client/dist/app.js'), 'console.log(1);\n');
    writeFileSync(join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(root, '.git/refs/heads/main'), 'b670ee6aa11bb22cc33dd44ee55ff66aa77bb88\n');
    return root;
  };

  it('fingerprints a tree by paths, sizes and times, skipping node_modules', () => {
    const r = tree();
    const before = fingerprint(join(r, 'src'));
    writeFileSync(join(r, 'src/node_modules/x/index.js'), 'ignored');
    expect(fingerprint(join(r, 'src'))).toBe(before);
    writeFileSync(join(r, 'src/api/http.ts'), 'export const changed = 1;\n');
    expect(fingerprint(join(r, 'src'))).not.toBe(before);
  });

  it('reads the commit from .git: a branch ref, packed refs, or a detached head', () => {
    const r = tree();
    expect(gitCommit(r)).toBe('b670ee6');
    rmSync(join(r, '.git/refs/heads/main'));
    writeFileSync(join(r, '.git/packed-refs'), '# pack-refs with: peeled\n1234567890abcdef refs/heads/main\n');
    expect(gitCommit(r)).toBe('1234567');
    writeFileSync(join(r, '.git/HEAD'), 'abcdef0123456789\n');
    expect(gitCommit(r)).toBe('abcdef0');
    expect(gitCommit(join(r, 'nowhere'))).toBeNull();
  });

  it('a server whose code changed on disk needs a restart; changed client files show in the fingerprint', () => {
    const r = tree();
    const v = createVersionInfo({ root: r, cacheMs: 0 });
    const first = v.now();
    expect(first).toMatchObject({ commit: 'b670ee6', commitOnDisk: 'b670ee6', restartNeeded: false });

    // git pull: new client files and a new commit, the server's code untouched so far.
    writeFileSync(join(r, 'client/dist/app.js'), 'console.log(2);\n');
    writeFileSync(join(r, '.git/refs/heads/main'), 'c0ffee11aa22bb33\n');
    const later = v.now();
    expect(later.client).not.toBe(first.client);
    expect(later).toMatchObject({ commit: 'b670ee6', commitOnDisk: 'c0ffee1', restartNeeded: false });

    // ...and the server's code: it must restart to run it.
    const file = join(r, 'src/api/http.ts');
    writeFileSync(file, 'export {};\n');
    utimesSync(file, new Date(), new Date(Date.now() + 60_000));
    expect(v.now().restartNeeded).toBe(true);
  });

  it('GET /api/system/version reports the running server', async () => {
    const h = mindsHarness();
    try {
      const server = Fastify();
      await registerHttpRoutes(server, h.app);
      const res = await server.inject({ method: 'GET', url: '/api/system/version' });
      expect(res.statusCode).toBe(200);
      const v = res.json();
      expect(v.restartNeeded).toBe(false);
      expect(typeof v.client).toBe('string');
      expect(v.startedAt).toBeGreaterThan(0);
    } finally {
      h.close();
    }
  });
});

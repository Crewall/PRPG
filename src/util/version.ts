import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The version check (docs/10 §11.2). After an update (git pull) two things can lag behind the files on disk:
// the running server (it loaded its code at startup) and an open tab (it keeps the scripts it loaded). The server
// fingerprints its own code at startup and, on request, the code and the client files as they are on disk now.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A short fingerprint of the files under `dir`: their paths, sizes and modification times. */
export function fingerprint(dir: string): string {
  const hash = createHash('sha1');
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(p);
      } else if (e.isFile()) {
        const s = statSync(p);
        hash.update(`${p.slice(dir.length)}\0${s.size}\0${s.mtimeMs}\n`);
      }
    }
  };
  walk(dir);
  return hash.digest('hex').slice(0, 12);
}

/** The git commit checked out (7 characters), read from .git without the git binary; null outside a checkout. */
export function gitCommit(root = ROOT): string | null {
  try {
    const head = readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head.slice(0, 7) || null;
    const ref = head.slice(5);
    const loose = join(root, '.git', ref);
    if (existsSync(loose)) return readFileSync(loose, 'utf8').trim().slice(0, 7) || null;
    const packed = readFileSync(join(root, '.git', 'packed-refs'), 'utf8')
      .split('\n')
      .find((l) => l.endsWith(` ${ref}`));
    return packed ? packed.slice(0, 7) : null;
  } catch {
    return null;
  }
}

export interface VersionNow {
  /** The commit the server started on, and the one checked out now. */
  commit: string | null;
  commitOnDisk: string | null;
  startedAt: number;
  /** The client files on disk now; a tab compares it with what it saw when it loaded. */
  client: string;
  /** The server's code on disk differs from what it started with: it needs a restart. */
  restartNeeded: boolean;
}

export function createVersionInfo(opts: { root?: string; cacheMs?: number } = {}) {
  const root = opts.root ?? ROOT;
  const srcDir = join(root, 'src');
  const clientDir = join(root, 'client', 'dist');
  const cacheMs = opts.cacheMs ?? 5000;
  const loaded = { server: fingerprint(srcDir), commit: gitCommit(root), startedAt: Date.now() };
  let cache: { at: number; value: VersionNow } | undefined;
  return {
    now(): VersionNow {
      if (cache && Date.now() - cache.at < cacheMs) return cache.value;
      const value: VersionNow = {
        commit: loaded.commit,
        commitOnDisk: gitCommit(root),
        startedAt: loaded.startedAt,
        client: fingerprint(clientDir),
        restartNeeded: fingerprint(srcDir) !== loaded.server,
      };
      cache = { at: Date.now(), value };
      return value;
    },
  };
}

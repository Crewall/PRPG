import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { logger } from '../util/logger.ts';

// node:sqlite is a recent built-in; some bundlers/test runners can't resolve the
// `node:` specifier statically. Load it through createRequire so it stays opaque
// to static analysis and resolves natively at runtime (Node >= 22).
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = InstanceType<typeof DatabaseSync>;

// The DB is kept behind this tiny interface so the underlying driver is
// swappable (node:sqlite here — no native build; better-sqlite3 could drop in
// on platforms with prebuilt binaries). See 01-tech-stack.md.
export interface Statement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get<T = Row>(...params: unknown[]): T | undefined;
  all<T = Row>(...params: unknown[]): T[];
}

export type Row = Record<string, unknown>;

export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  transaction<T>(fn: () => T): T;
  pragma(key: string): unknown;
  close(): void;
  readonly raw: DatabaseSync;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Open (creating the parent directory as needed) a SQLite database. */
export function openDb(path: string): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec('PRAGMA busy_timeout = 5000;');

  return {
    raw,
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => raw.prepare(sql) as unknown as Statement,
    pragma: (key) => (raw.prepare(`PRAGMA ${key}`).get() as Row | undefined),
    transaction<T>(fn: () => T): T {
      raw.exec('BEGIN');
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
    close: () => raw.close(),
  };
}

/**
 * Apply any migration .sql files in migrations/ that have not yet run, in
 * filename order. Idempotent: re-running is a no-op. Records applied files in
 * the `_migrations` table.
 */
export function migrate(db: Db, migrationsDir = MIGRATIONS_DIR): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );`);

  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all<{ name: string }>().map((r) => r.name),
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const run: string[] = [];
  const record = db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)');
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(file, Date.now());
    });
    run.push(file);
    logger.info('migration applied', { file });
  }
  return run;
}

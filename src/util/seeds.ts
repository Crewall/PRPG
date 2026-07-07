import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Story-seed phrases for the premise randomizer. The file is read on every
// call so it can be edited (or replaced with your own 100 phrases) without a
// restart. True randomness comes from the engine's roll, not the LLM.
const SEEDS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'story-seeds.txt');

export function loadSeeds(path = SEEDS_PATH): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Roll `n` distinct seeds (Fisher–Yates partial shuffle). */
export function rollSeeds(n: number, opts: { seeds?: string[]; rng?: () => number } = {}): string[] {
  const pool = [...(opts.seeds ?? loadSeeds())];
  const rng = opts.rng ?? Math.random;
  const take = Math.min(n, pool.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rng() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, take);
}

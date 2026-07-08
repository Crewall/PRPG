import { describe, it, expect } from 'vitest';
import { loadSeeds, rollSeeds } from '../src/util/seeds.ts';

describe('story seed roller', () => {
  it('ships 250 seed phrases', () => {
    expect(loadSeeds().length).toBe(250);
  });

  it('rolls 5 distinct seeds from the pool', () => {
    const rolled = rollSeeds(5);
    expect(rolled).toHaveLength(5);
    expect(new Set(rolled).size).toBe(5);
    const pool = new Set(loadSeeds());
    for (const s of rolled) expect(pool.has(s)).toBe(true);
  });

  it('is deterministic under an injected rng and varies across rolls', () => {
    const seeds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const a = rollSeeds(3, { seeds, rng: () => 0 });
    const b = rollSeeds(3, { seeds, rng: () => 0 });
    expect(a).toEqual(b);
    // A different rng path picks a different set.
    let i = 0;
    const c = rollSeeds(3, { seeds, rng: () => [0.9, 0.5, 0.1][i++ % 3] });
    expect(c).not.toEqual(a);
    expect(new Set(c).size).toBe(3);
  });
});

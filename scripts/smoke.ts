// Layer 0 deliverable: `npm run smoke`.
// Loads config, opens+migrates the DB, then runs one streamed completion and one
// schema-enforced JSON completion against each configured provider. Exits non-zero
// on any failure so it doubles as a health check on desktop and inside Termux.

import { z } from 'zod';
import { loadConfig } from '../src/config/config.ts';
import { openDb, migrate } from '../src/db/db.ts';
import { createRegistry } from '../src/llm/registry.ts';
import { callJson } from '../src/llm/jsonCall.ts';
import type { ProviderKind } from '../src/config/config.ts';

const CONFIG_PATH = process.env.PRPG_CONFIG ?? 'config.json';

function pickProfileFor(provider: ProviderKind, profiles: Record<string, { provider: ProviderKind }>): string | undefined {
  return Object.entries(profiles).find(([, p]) => p.provider === provider)?.[0];
}

async function main(): Promise<void> {
  console.log('PRPG smoke test\n===============');

  const config = loadConfig(CONFIG_PATH);
  console.log('✓ config loaded and validated');

  const db = openDb(config.db.path);
  const applied = migrate(db);
  const tableCount = (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get() as { n: number }).n;
  console.log(`✓ database opened at ${config.db.path} (${tableCount} tables, ${applied.length} migration(s) applied this run)`);
  db.close();

  const registry = createRegistry(() => config);
  const providers = Object.keys(config.providers) as ProviderKind[];

  let failures = 0;
  for (const provider of providers) {
    const profileName = pickProfileFor(provider, config.modelProfiles);
    if (!profileName) {
      console.log(`- ${provider}: no model profile uses this provider, skipping`);
      continue;
    }
    const bound = registry.getProfile(profileName);
    console.log(`\n[${provider}] profile '${profileName}' -> model '${bound.profile.model}'`);

    // 1) Streamed free-text completion.
    try {
      let streamed = '';
      const t0 = Date.now();
      const res = await bound.chat(
        {
          system: 'You are a terse assistant.',
          messages: [{ role: 'user', content: 'Reply with exactly: PRPG streaming works.' }],
          maxTokens: 32,
        },
        (delta) => {
          streamed += delta;
          process.stdout.write(delta);
        },
      );
      console.log(`\n  ✓ stream ok (${Date.now() - t0}ms, in=${res.usage.inputTokens} out=${res.usage.outputTokens})`);
      if (!streamed.trim()) throw new Error('empty stream');
    } catch (err) {
      failures++;
      console.error(`  ✗ stream FAILED: ${(err as Error).message}`);
    }

    // 2) Schema-enforced JSON completion (exercises callJson + repair path).
    try {
      const Schema = z.object({ ok: z.boolean(), engine: z.string() });
      const t0 = Date.now();
      const parsed = await callJson(
        bound,
        {
          system: 'You output only JSON.',
          messages: [{ role: 'user', content: 'Return JSON: {"ok": true, "engine": "PRPG"}' }],
        },
        Schema,
      );
      console.log(`  ✓ json ok (${Date.now() - t0}ms): ${JSON.stringify(parsed)}`);
    } catch (err) {
      failures++;
      console.error(`  ✗ json FAILED: ${(err as Error).message}`);
    }
  }

  console.log(`\n===============\n${failures === 0 ? 'SMOKE PASSED ✓' : `SMOKE FAILED ✗ (${failures} error(s))`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nSMOKE FAILED ✗');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

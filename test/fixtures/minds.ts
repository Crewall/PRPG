import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../../src/config/config.ts';
import { createApp } from '../../src/app.ts';
import type { App } from '../../src/app.ts';
import type { RunOptions, TurnEmitter } from '../../src/orchestrator/turnPipeline.ts';
import type { Turn } from '../../src/domain.ts';
import type { ChatRequest, LlmDriver } from '../../src/llm/types.ts';
import { VariableDef } from '../../src/minds/variables.ts';
import { createCharacter } from '../../src/minds/service.ts';
import type { MindsDeps } from '../../src/minds/service.ts';

// Shared harness for Minds tests: a fake model that answers by agent (narrator,
// a character by name, distributor, seeder, compactor) and records every request.

export const mindsConfig = parseConfig({
  providers: { anthropic: { apiKey: 'sk-test' } },
  modelProfiles: { m: { provider: 'anthropic', model: 'm' } },
  roles: { storyteller: 'm', npc: 'm', scribe_memory: 'm', scribe_story: 'm', overseer: 'm' },
});

export type Reply = string | ((req: ChatRequest) => string);
export interface Script {
  narrator: Reply[];
  characters: Record<string, Reply[]>; // by character name
  distributor: Reply[];
  seeder: Reply[];
  compactor: Reply[];
  director: Reply[];
}
export const emptyScript = (): Script => ({ narrator: [], characters: {}, distributor: [], seeder: [], compactor: [], director: [] });

export function agentOf(req: ChatRequest): string {
  if (req.system.includes('You are the **Narrator**')) return 'narrator';
  if (req.system.includes('forgot (or broke)')) return 'distributor';
  if (req.system.includes('character designer')) return 'seeder';
  if (req.system.includes('You fold the oldest part')) return 'compactor';
  if (req.system.includes('You decide who is being spoken to')) return 'director';
  const m = req.system.match(/^You are \*\*(.+?)\*\*/);
  return m ? `character:${m[1]}` : 'other';
}

export function dispatchDriver(script: Script, seen: { agent: string; req: ChatRequest }[]): LlmDriver {
  return {
    kind: 'anthropic',
    async chat(req, onDelta) {
      const agent = agentOf(req);
      seen.push({ agent, req });
      const queue =
        agent === 'narrator' ? script.narrator
        : agent === 'distributor' ? script.distributor
        : agent === 'seeder' ? script.seeder
        : agent === 'compactor' ? script.compactor
        : agent === 'director' ? script.director
        : script.characters[agent.slice('character:'.length)] ?? [];
      const next = queue.shift();
      if (next === undefined) throw new Error(`no scripted reply for ${agent}`);
      const text = typeof next === 'function' ? next(req) : next;
      if (onDelta) for (const chunk of text.match(/[\s\S]{1,7}/g) ?? []) onDelta(chunk);
      return { text, usage: { inputTokens: 1, outputTokens: 1 }, model: req.model };
    },
  };
}

export const fail = (msg: string): Reply => () => {
  throw new Error(msg);
};

/** A narrator reply: prose plus the hidden ```round block. */
export const round = (prose: string, block: unknown) => `${prose}\n\n\`\`\`round\n${JSON.stringify(block)}\n\`\`\``;

export function collector() {
  const c = { deltas: [] as string[], status: [] as string[], final: null as Turn | null, errors: [] as string[], emitter: null as unknown as TurnEmitter };
  c.emitter = {
    accepted: () => {},
    status: (t) => c.status.push(t),
    delta: (t) => c.deltas.push(t),
    final: (turn) => (c.final = turn),
    rejected: () => {},
    error: (_id, m) => c.errors.push(m),
  };
  return c;
}

export const textOf = (req: ChatRequest) => `${req.system}\n${req.messages.map((m) => m.content).join('\n')}`;

/**
 * A Minds story at the Broken Wheel inn: player Kael, three variables
 * (health: self-visible; suspicion: hidden, NPCs only; alarm: world).
 * `opening()` plays round 1, in which the narrator brings in Marta and Tom.
 */
export function mindsHarness(opts: { player?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prpg-minds-'));
  const script = emptyScript();
  const seen: { agent: string; req: ChatRequest }[] = [];
  const app: App = createApp(mindsConfig, { driverFactory: () => dispatchDriver(script, seen), dbPath: join(dir, 'm.db'), startWorker: false });
  const deps: MindsDeps = { stories: app.stories, memory: app.memory, sheets: app.sheets, variables: app.variables, thoughts: app.thoughts, names: app.names, ties: app.ties };
  const storyId = app.stories.createStory({ title: 'Inn', settings: { engine: 'minds', premise: 'A smugglers’ inn.' } as never }).id;
  app.variables.replaceDefs(
    storyId,
    [
      { key: 'health', label: 'Health', type: 'number', min: 0, max: 10, default: 10, visibility: 'self', changedBy: ['narrator'] },
      { key: 'suspicion', label: 'Suspicion', type: 'number', min: 0, max: 100, default: 20, appliesTo: 'npcs', visibility: 'hidden', changedBy: ['narrator'] },
      { key: 'alarm', label: 'Alarm', type: 'number', min: 0, max: 5, scope: 'world', visibility: 'public', changedBy: ['narrator'] },
    ].map((d) => VariableDef.parse(d)),
  );
  if (opts.player !== false) createCharacter(deps, storyId, { name: 'Kael', isPlayer: true, appearance: 'Tall, rain-soaked.' });

  const h = {
    dir,
    app,
    script,
    seen,
    deps,
    storyId,
    requests: (agent: string) => seen.filter((s) => s.agent === agent).map((s) => s.req),
    play: async (input: string, opts: RunOptions = {}) => {
      const c = collector();
      await app.pipeline.run(storyId, input, c.emitter, opts);
      return c;
    },
    sessionOf: (oid: string) => app.agents.listSessions(storyId).find((s) => s.role === 'character' && s.npcObjectId === oid)!.id,
    narratorSession: () => app.agents.listSessions(storyId).find((s) => s.role === 'narrator')!.id,
    idOf: (name: string) => app.memory.findByName(storyId, name)!.id,
    opening: async () => {
      script.narrator.push(
        round('Rain hammers the Broken Wheel. Behind the counter, a stout woman; by the fire, a thin man.', {
          cast: { enter: [{ name: 'Marta', appearance: 'Stout, flour on her apron.' }, { name: 'Tom', appearance: 'Thin, nervous.' }] },
          briefs: { Marta: 'A tall stranger walks in out of the rain.', '#tom': 'A tall stranger walks in; Marta stiffens.' },
          scene: { location: '#broken-wheel', items: ['#ledger'] },
          time: 15,
        }),
      );
      return h.play('');
    },
    close: () => {
      app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}
export type MindsHarness = ReturnType<typeof mindsHarness>;

import { z } from 'zod';
import { RoleName } from './config/config.ts';

// Domain types + Zod schemas shared across stores, API and orchestrator.
// StorySettings is persisted per story (settings_json) and validated on read/write.

// The narrator voice/style fed to the storyteller prompt's {{tone}}. Per-story
// (editable in Story options); new stories can inherit a global default set in
// Settings → Storyteller style.
export const DEFAULT_TONE = 'immersive, second-person present tense';

// Which engine plays the story (docs/10 §4). 'classic' = fact-extraction
// memory; 'npc_stories' = NPC Story Mode (docs/09); 'minds' = narrator +
// character minds (docs/10–11). Replaces the old npcStories.enabled flag,
// which is kept in sync for code that still reads it.
export const StoryEngine = z.enum(['classic', 'npc_stories', 'minds']);
export type StoryEngine = z.infer<typeof StoryEngine>;

export const StorySettings = z.object({
  engine: StoryEngine.default('classic'),
  // Per-role model-profile overrides (fall back to config.roles when absent).
  roles: z.record(RoleName, z.string()).default({}),
  // Free-text opening premise the storyteller builds the world from.
  premise: z.string().default(''),
  genre: z.string().default('freeform'),
  tone: z.string().default(DEFAULT_TONE),
  // Storyteller reply length, 1 (terse) … 5 (expansive). Storyteller only —
  // scribes/NPCs are unaffected.
  verbosity: z.number().int().min(1).max(5).default(3),
  // The player's own character object in memory (set by the intake interview).
  playerObjectId: z.string().nullable().default(null),
  overseer: z
    .object({
      enabled: z.boolean().default(false),
      checkPlayerInput: z.boolean().default(false),
    })
    .default({}),
  budgets: z
    .object({
      recentTurns: z.number().int().positive().default(6), // K
      digestTokens: z.number().int().positive().default(1200),
      sceneSummaryTokens: z.number().int().positive().default(500),
      retrievedMemoryTokens: z.number().int().positive().default(1500),
    })
    .default({}),
  // How the storyteller's context is assembled (feature 4).
  // - summaryDriven=false (default): digest + scene summary + last-K raw turns.
  // - summaryDriven=true: summary + prompt + scene characters + goals +
  //   planner-guided memory retrieval instead of the chat history.
  context: z
    .object({
      summaryDriven: z.boolean().default(false),
      // A cheap AI pass that decides which memories (and at which tier depth)
      // the storyteller needs this turn. Falls back to lexical retrieval off.
      plannerEnabled: z.boolean().default(true),
    })
    .default({}),
  // NPC Story Mode (docs/09): replaces the structured memory pipeline for
  // NPCs. Each present NPC acts every round from a mechanically personalized
  // excerpt of the main story, keeps its own narrative notes, and its
  // words/intents are woven by the storyteller in a single pass. While
  // enabled: no scribe_memory jobs, no retrieval blocks, consult_npc ignored.
  // The context planner is skipped too (it only plans memory retrieval).
  npcStories: z
    .object({
      enabled: z.boolean().default(false),
      /** Max tokens kept of each NPC's private notes (server-side truncation). */
      notesTokens: z.number().int().positive().default(300),
      /** Reply-length cap when a character's personality is first written (npc_seed). */
      personalityTokens: z.number().int().positive().default(800),
      /** Max tokens kept of an AI-written personality (server-side truncation). */
      personalityMaxTokens: z.number().int().positive().default(400),
      /** How many recent present-turns each NPC sees verbatim. */
      presentTurns: z.number().int().positive().default(4),
      /** Cap on NPC calls per round (first-listed in the scene win). */
      maxNpcsPerRound: z.number().int().positive().default(4),
    })
    .default({}),
  // Minds engine (docs/10 §12, docs/11): budgets and switches.
  minds: z
    .object({
      maxCharactersPerRound: z.number().int().positive().default(4),
      briefMaxWords: z.number().int().positive().default(70),
      characterLogTokens: z.number().int().positive().default(8000),
      narratorLogTokens: z.number().int().positive().default(32000),
      descriptionMaxWords: z.number().int().positive().default(250),
      thoughtRecallTokens: z.number().int().positive().default(300),
      pinnedTokens: z.number().int().positive().default(400),
      maxActiveThoughts: z.number().int().positive().default(80),
      narratorSeesThoughts: z.boolean().default(false),
      playerSpeechHeardImmediately: z.boolean().default(true),
      // The narrator's secret setup notes (plans, twists): only the narrator sees them.
      narratorNotes: z.string().default(''),
    })
    .default({}),
  // The adjudicator: uncertain, consequential attempts are judged by a
  // separate impartial AI (difficulty + circumstances) and decided by a real
  // hidden dice roll, instead of the storyteller deciding outcomes itself.
  adjudicator: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({}),
  // The salience system (per-object importance: retrieval weighting, scribe
  // updates, periodic decay). Optional — off means salience is frozen and
  // ignored in ranking.
  salience: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({}),
  debug: z
    .object({
      showThreads: z.boolean().default(false),
    })
    .default({}),
});
export type StorySettings = z.infer<typeof StorySettings>;

export function defaultStorySettings(): StorySettings {
  return StorySettings.parse({});
}

/**
 * Parse story settings, applying `patch` on top of `base` (shallow, per
 * top-level key), with the engine resolved consistently:
 *  - stored settings without `engine` derive it from the old npcStories flag;
 *  - a patch that only flips npcStories.enabled moves the engine with it
 *    (the existing NPC Story Mode toggle keeps working);
 *  - npcStories.enabled always mirrors engine === 'npc_stories'.
 */
export function resolveStorySettings(base: Record<string, unknown>, patch: Record<string, unknown> = {}): StorySettings {
  const flagOf = (x: Record<string, unknown>) => (x.npcStories as { enabled?: unknown } | undefined)?.enabled;
  const baseEngine = (base.engine as StoryEngine | undefined) ?? (flagOf(base) === true ? 'npc_stories' : 'classic');
  let engine = (patch.engine as StoryEngine | undefined) ?? baseEngine;
  const flag = flagOf(patch);
  if (patch.engine === undefined && typeof flag === 'boolean' && flag !== (baseEngine === 'npc_stories')) {
    engine = flag ? 'npc_stories' : baseEngine === 'npc_stories' ? 'classic' : baseEngine;
  }
  const settings = StorySettings.parse({ ...base, ...patch, engine });
  settings.npcStories.enabled = settings.engine === 'npc_stories';
  return settings;
}

export type StoryStatus = 'active' | 'archived';
export type TurnStatus = 'streaming' | 'complete' | 'rejected' | 'error';
export type SceneStatus = 'open' | 'closed';
export type SessionState = 'active' | 'dormant' | 'closed';

export interface Story {
  id: string;
  title: string;
  settings: StorySettings;
  currentSceneId: string | null;
  /** Hidden in-game clock: minutes since Day 1, 00:00 (stories start at Day 1, 08:00). */
  clockMin: number;
  status: StoryStatus;
  createdAt: number;
  updatedAt: number;
}

export interface Scene {
  id: string;
  storyId: string;
  index: number;
  title: string | null;
  locationObjectId: string | null;
  activeNpcIds: string[];
  status: SceneStatus;
}

export interface Turn {
  id: string;
  storyId: string;
  sceneId: string | null;
  index: number;
  playerInput: string;
  narration: string;
  status: TurnStatus;
  meta: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface AgentSession {
  id: string;
  storyId: string;
  role: RoleName;
  npcObjectId: string | null;
  modelProfile: string;
  state: SessionState;
}

export interface AgentMessage {
  id: string;
  sessionId: string;
  turnId: string | null;
  role: 'system' | 'user' | 'assistant';
  content: string;
  pinned: boolean;
}

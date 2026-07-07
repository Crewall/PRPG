import { z } from 'zod';
import { RoleName } from './config/config.ts';

// Domain types + Zod schemas shared across stores, API and orchestrator.
// StorySettings is persisted per story (settings_json) and validated on read/write.

export const StorySettings = z.object({
  // Per-role model-profile overrides (fall back to config.roles when absent).
  roles: z.record(RoleName, z.string()).default({}),
  // Free-text opening premise the storyteller builds the world from.
  premise: z.string().default(''),
  genre: z.string().default('freeform'),
  tone: z.string().default('immersive, second-person present tense'),
  overseer: z
    .object({
      enabled: z.boolean().default(false),
      checkPlayerInput: z.boolean().default(false),
    })
    .default({}),
  budgets: z
    .object({
      recentTurns: z.number().int().positive().default(6), // K
      digestTokens: z.number().int().positive().default(800),
      sceneSummaryTokens: z.number().int().positive().default(300),
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

export type StoryStatus = 'active' | 'archived';
export type TurnStatus = 'streaming' | 'complete' | 'rejected' | 'error';
export type SceneStatus = 'open' | 'closed';
export type SessionState = 'active' | 'dormant' | 'closed';

export interface Story {
  id: string;
  title: string;
  settings: StorySettings;
  currentSceneId: string | null;
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

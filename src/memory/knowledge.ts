import type { DetailLevel, KnowledgeScope, KnowledgeLink, MemoryFact } from './model.ts';

// The disclosure matrix (doc 05), implemented once. Given a fact, its knowledge
// links, and a scope, decide whether the scope may see it and — for knowers with
// a distortion — what content they actually believe.

export interface Disclosure {
  visible: boolean;
  /** Distortion text to substitute for the real content, if any. */
  distortion: string | null;
}

const HIDDEN: Disclosure = { visible: false, distortion: null };
const SHOWN: Disclosure = { visible: true, distortion: null };

/**
 * Decide disclosure of one fact to one scope.
 *
 * - visible → everyone (any scope, incl. bare perception).
 * - known/secret → only linked knowers (player and/or specific NPC); storyteller
 *   sees all. Distortions apply to the knower's own link.
 * - hidden → storyteller only (never player, never any NPC — even the subject).
 */
export function discloseFact(fact: Pick<MemoryFact, 'detailLevel'>, links: KnowledgeLink[], scope: KnowledgeScope): Disclosure {
  const level: DetailLevel = fact.detailLevel;

  // Storyteller is omniscient.
  if (scope.kind === 'storyteller') return SHOWN;

  // Visible facts are perceivable by anyone.
  if (level === 'visible') return SHOWN;

  // Hidden facts are authorial — storyteller only (handled above).
  if (level === 'hidden') return HIDDEN;

  // known / secret — require an explicit knowledge link for this scope.
  if (scope.kind === 'perception') return HIDDEN; // a bare glance sees only `visible`

  if (scope.kind === 'player') {
    const link = links.find((l) => l.knowerType === 'player');
    return link ? { visible: true, distortion: link.distortion ?? null } : HIDDEN;
  }

  // scope.kind === 'npc'
  const link = links.find((l) => l.knowerType === 'npc' && l.knowerNpcObjectId === scope.npcObjectId);
  return link ? { visible: true, distortion: link.distortion ?? null } : HIDDEN;
}

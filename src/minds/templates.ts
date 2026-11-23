import { VariableDef } from './variables.ts';

// Starting points for a scenario's variables (docs/11 §4.8). They only fill the
// list; the user edits from there. Parsed at load so a typo fails loudly.

export interface ScenarioTemplate {
  id: string;
  label: string;
  description: string;
  variables: VariableDef[];
}

const T = (id: string, label: string, description: string, variables: unknown[]): ScenarioTemplate => ({
  id,
  label,
  description,
  variables: variables.map((v, i) => VariableDef.parse({ order: i, ...(v as object) })),
});

export const SCENARIO_TEMPLATES: ScenarioTemplate[] = [
  T('simple-adventure', 'Simple adventure', 'Health, stamina, mood and what each character carries.', [
    {
      key: 'health', label: 'Health', type: 'number', min: 0, max: 10, default: 10, maxStep: 4,
      bands: [{ upTo: 2, label: 'critical' }, { upTo: 5, label: 'hurt' }, { upTo: 10, label: 'fine' }],
      visibility: 'self', changedBy: ['narrator'],
      description: 'Physical condition. 0 = incapacitated, 10 = unhurt.',
      changeGuide: 'Lower by 1–4 when hurt, raise when treated or rested.',
    },
    {
      key: 'stamina', label: 'Stamina', type: 'number', min: 0, max: 10, default: 8, maxStep: 3,
      visibility: 'self', changedBy: ['narrator'],
      description: 'Energy left for effort. 0 = exhausted.',
      changeGuide: 'Lower after exertion, restore with rest or food.',
    },
    {
      key: 'mood', label: 'Mood', type: 'text', maxWords: 6, default: 'calm',
      visibility: 'self', changedBy: ['self', 'narrator'],
      description: 'How the character feels right now, in a few words.',
      changeGuide: 'Change it whenever the feeling shifts.',
    },
    {
      key: 'carrying', label: 'Carrying', type: 'list', maxItems: 12, itemMaxWords: 5,
      visibility: 'self', changedBy: ['narrator', 'self'],
      description: 'What the character has on them.',
      changeGuide: 'The narrator adds what is found or given and removes what is lost or used; a character may drop items.',
    },
  ]),
  T('intrigue', 'Intrigue', 'Hidden trust and loyalty for every non-player character, plus visible composure.', [
    {
      key: 'trust_in_player', label: 'Trust in the player', type: 'number', min: 0, max: 100, default: 50, maxStep: 15,
      appliesTo: 'npcs', visibility: 'hidden', changedBy: ['narrator'],
      bands: [{ upTo: 20, label: 'hostile' }, { upTo: 45, label: 'wary' }, { upTo: 70, label: 'neutral' }, { upTo: 100, label: 'trusting' }],
      description: 'How far this character trusts the player character. The character does not know this number.',
      changeGuide: 'Raise for kept promises and help, lower for lies, threats and betrayals.',
    },
    {
      key: 'loyalty', label: 'Loyalty', type: 'choice', options: ['crown', 'rebels', 'self'], default: 'self',
      appliesTo: 'npcs', visibility: 'hidden', changedBy: ['narrator'],
      description: 'Where this character’s loyalty truly lies.',
      changeGuide: 'Change only after a decisive turn of events.',
    },
    {
      key: 'composure', label: 'Composure', type: 'number', min: 0, max: 10, default: 7, maxStep: 3,
      visibility: 'self', changedBy: ['self', 'narrator'],
      description: 'How well the character keeps a calm face. 0 = breaking down.',
      changeGuide: 'Lower under pressure or shock, raise when back in control.',
    },
  ]),
  T('survival', 'Survival', 'Shared supplies, weather and day count, plus each character’s exhaustion.', [
    {
      key: 'supplies', label: 'Supplies', type: 'number', min: 0, default: 10, maxStep: 5,
      scope: 'world', visibility: 'public', changedBy: ['narrator'],
      description: 'Days of food and water left for the group.',
      changeGuide: 'Lower by 1 per day, more when shared or spoiled; raise when found.',
    },
    {
      key: 'weather', label: 'Weather', type: 'choice', options: ['clear', 'rain', 'storm', 'snow', 'heat'], default: 'clear',
      scope: 'world', visibility: 'public', changedBy: ['narrator'],
      description: 'The current weather.', changeGuide: 'Change it as time passes and the story needs.',
    },
    {
      key: 'day', label: 'Day', type: 'number', min: 1, default: 1, maxStep: 3,
      scope: 'world', visibility: 'public', changedBy: ['narrator'],
      description: 'Days survived so far.', changeGuide: 'Raise by 1 at each new day.',
    },
    {
      key: 'exhaustion', label: 'Exhaustion', type: 'number', min: 0, max: 10, default: 0, maxStep: 3,
      visibility: 'self', changedBy: ['narrator'],
      bands: [{ upTo: 3, label: 'fresh' }, { upTo: 6, label: 'tired' }, { upTo: 10, label: 'spent' }],
      description: 'How worn out the character is. 10 = collapsing.',
      changeGuide: 'Raise after hard effort or lost sleep, lower with rest.',
    },
  ]),
  T('relationships', 'Relationships', 'How each character feels toward each person they have met: trust, affection, and a shared rivalry.', [
    {
      key: 'trust', label: 'Trust', type: 'number', min: 0, max: 10, default: 5, maxStep: 2, scope: 'relation',
      bands: [{ upTo: 2, label: 'distrusts' }, { upTo: 6, label: 'unsure' }, { upTo: 10, label: 'trusts' }],
      visibility: 'self', changedBy: ['narrator', 'self'],
      description: 'How much they trust that person. 0 = expects betrayal, 10 = would trust them with their life.',
      changeGuide: 'Raise when they keep their word or take a risk for them; lower on lies, betrayal or threats.',
    },
    {
      key: 'affection', label: 'Affection', type: 'number', min: 0, max: 10, default: 3, maxStep: 2, scope: 'relation',
      visibility: 'self', changedBy: ['narrator', 'self'],
      description: 'How much they like that person. 0 = loathing, 10 = love.',
      changeGuide: 'Change it slowly, as shared moments, kindness or cruelty add up.',
    },
    {
      key: 'rivalry', label: 'Rivalry', type: 'number', min: 0, max: 10, default: 0, maxStep: 2, scope: 'relation', mutual: true,
      visibility: 'public', changedBy: ['narrator'],
      description: 'Open competition between the two. 0 = none, 10 = bitter rivals.',
      changeGuide: 'Raise when they compete or clash in front of others; lower when they make peace.',
    },
  ]),
];

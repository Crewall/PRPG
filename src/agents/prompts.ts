import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'prompts');
const cache = new Map<string, string>();

/** Load a versioned prompt template from src/agents/prompts/<name>.md. */
export function loadPrompt(name: string): string {
  let tpl = cache.get(name);
  if (tpl === undefined) {
    tpl = readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf8');
    cache.set(name, tpl);
  }
  return tpl;
}

/** Render a template, substituting {{key}} placeholders. Unknown keys become ''. */
export function renderPrompt(name: string, vars: Record<string, string>): string {
  return loadPrompt(name).replace(/\{\{(\w+)\}\}/g, (_m, key) => vars[key] ?? '');
}

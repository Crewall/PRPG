import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'prompts');
const fileCache = new Map<string, string>();

// Runtime prompt overrides (edited from the Settings UI). When set for a name,
// the override text is used instead of the on-disk template.
let overrideProvider: (name: string) => string | undefined = () => undefined;

export function setPromptOverrideProvider(fn: (name: string) => string | undefined): void {
  overrideProvider = fn;
}

/** The on-disk default template for a prompt (ignores overrides). */
export function defaultPrompt(name: string): string {
  let tpl = fileCache.get(name);
  if (tpl === undefined) {
    tpl = readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf8');
    fileCache.set(name, tpl);
  }
  return tpl;
}

/** Load a prompt template — an override if one is set, else the on-disk default. */
export function loadPrompt(name: string): string {
  return overrideProvider(name) ?? defaultPrompt(name);
}

/** Render a template, substituting {{key}} placeholders. Unknown keys become ''. */
export function renderPrompt(name: string, vars: Record<string, string>): string {
  return loadPrompt(name).replace(/\{\{(\w+)\}\}/g, (_m, key) => vars[key] ?? '');
}

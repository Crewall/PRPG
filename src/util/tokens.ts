// Cheap, provider-agnostic token estimate. The chars/4 heuristic is documented
// in 06-orchestration.md; a real tokenizer can replace this behind the same name.

/** Estimate the token count of a string (chars/4 heuristic). */
export function estimateTokens(s: string): number {
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

/** Estimate the token count of a chat message list (role overhead included). */
export function estimateMessageTokens(
  messages: { role: string; content: string }[],
): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content) + 4; // ~4 tokens of role/format overhead
  }
  return total;
}

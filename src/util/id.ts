import { randomBytes } from 'node:crypto';

// URL-safe, collision-resistant short id (nanoid-style) without a dependency.
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';

/** Generate a short random id (default 16 chars ≈ 96 bits of entropy). */
export function id(size = 16): string {
  const bytes = randomBytes(size);
  let out = '';
  for (let i = 0; i < size; i++) {
    out += ALPHABET[bytes[i] & 63];
  }
  return out;
}

/** Prefixed id, e.g. prefixedId('st') -> 'st_A1b2...'. Handy for readable logs. */
export function prefixedId(prefix: string, size = 12): string {
  return `${prefix}_${id(size)}`;
}

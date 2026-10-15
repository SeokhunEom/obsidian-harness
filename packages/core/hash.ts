import { createHash } from 'node:crypto';
export const MISSING_HASH = 'MISSING';
export function hashText(text: string | null): string {
  return text === null ? MISSING_HASH : createHash('sha256').update(text, 'utf8').digest('hex');
}

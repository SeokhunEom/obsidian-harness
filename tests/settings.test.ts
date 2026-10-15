import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, dailyTarget } from '../apps/obsidian-plugin/settings';
import { getDestination } from '../packages/providers';
describe('first-use settings and date targets', () => {
  it('has no read, write, transfer, enabled provider, or confirmed storage by default', () => {
    const s = loadSettings(null);
    expect(s.storageConfirmed).toBe(false);
    expect(s.policy.readPaths).toEqual([]);
    expect(s.policy.writePaths).toEqual([]);
    expect(s.policy.transfers).toEqual([]);
    expect(s.generation.enabled).toBe(false);
    expect(s.embedding.enabled).toBe(false);
    expect(s.githubEnabled).toBe(false);
    expect(s.generation.apiKeySecret).toBe('');
  });
  it('keeps defaults independent between installations', () => {
    const a = loadSettings(null);
    a.policy.readPaths.push('Private');
    expect(loadSettings(null).policy.readPaths).toEqual([]);
  });
  it('formats user path without changing date meaning and rejects nonexistent dates', () => {
    expect(dailyTarget('Daily/{YYYY}/{MM}/{date}.md', '2026-10-15')).toBe(
      'Daily/2026/10/2026-10-15.md',
    );
    expect(() => dailyTarget('Daily/{date}.md', '2026-02-31')).toThrow();
    expect(() => dailyTarget('Daily/{date}.md', '../2026')).toThrow();
  });
  it('separates generation and embedding grants and invalidates destination on endpoint/model change', () => {
    const s = structuredClone(DEFAULT_SETTINGS),
      first = getDestination(s.generation);
    expect(getDestination(s.embedding)).not.toBe(first);
    s.generation.model = 'different';
    expect(getDestination(s.generation)).not.toBe(first);
    s.generation.baseUrl = 'https://internal.example/v1';
    expect(getDestination(s.generation)).not.toBe(first);
  });
});

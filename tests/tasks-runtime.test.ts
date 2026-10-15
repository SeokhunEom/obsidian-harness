import { describe, expect, it, vi } from 'vitest';
import { HarnessRuntime } from '../apps/obsidian-plugin/runtime';
import { DEFAULT_SETTINGS } from '../apps/obsidian-plugin/settings';
import { emptyState, type JsonStateStore } from '../packages/storage';
import type { ChatGPTAuth, SecretStore } from '../packages/providers';
import type { Job, SourceDocument } from '../packages/contracts';
import type { App } from 'obsidian';
function fixture() {
  const settings = structuredClone(DEFAULT_SETTINGS),
    state = emptyState('00000000-0000-4000-8000-000000000001');
  const snapshots: ReturnType<typeof emptyState>[] = [];
  const store = {
    state,
    readOnly: false,
    save: vi.fn(async () => {
      snapshots.push(structuredClone(state));
    }),
    close: vi.fn(async () => {}),
  };
  const app = {
    vault: { adapter: { getBasePath: () => '/tmp/harness-runtime-test' } },
  } as unknown as App;
  const secrets: SecretStore = {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
  };
  const runtime = new HarnessRuntime(
    app,
    store as unknown as JsonStateStore,
    () => settings,
    secrets,
    {} as ChatGPTAuth,
    () => {},
  );
  const execute = vi.spyOn(runtime as any, 'execute').mockResolvedValue(undefined);
  return { runtime, settings, state, store, snapshots, execute };
}
function sampleJob(now: number): Job {
  return {
    id: 'daily',
    version: 1,
    enabled: true,
    frequency: 'daily',
    localTime: '09:00',
    timezone: 'Asia/Seoul',
    deviceId: '00000000-0000-4000-8000-000000000001',
    scope: ['Work'],
    outputPath: 'Daily/{date}.md',
    skillId: 'daily-work-review',
    createdAt: now - 60_000,
    lastCheckedAt: now - 60_000,
    missedRunPolicy: 'latest_once_within_24h',
  };
}
const source: SourceDocument = {
  id: 'github:1',
  kind: 'github',
  path: 'acme/work/issues/1',
  uri: 'https://github.com/acme/work/issues/1',
  title: 'Task',
  text: 'approved content',
  hash: 'v1',
  updatedAt: 100,
  indexedAt: 100,
  project: 'acme/work',
  tags: [],
};
describe('runtime scheduling persistence', () => {
  it('persists occurrence and matching queued Run together before dispatching work', async () => {
    const { runtime, state, snapshots, execute } = fixture();
    const now = Date.parse('2026-10-15T00:00:00Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    state.jobs.push(sampleJob(now));
    try {
      await runtime.tick();
      await Promise.resolve();
      expect(state.runs).toHaveLength(1);
      expect(state.occurrences).toHaveLength(1);
      expect(
        snapshots.every((snapshot) =>
          snapshot.occurrences.every(
            (item) =>
              item.state !== 'queued' ||
              snapshot.runs.some((run) => run.occurrenceKey === item.key),
          ),
        ),
      ).toBe(true);
      expect(execute).toHaveBeenCalledTimes(1);
      await runtime.tick();
      expect(state.runs).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('rolls back in-memory dedupe state if the combined persistence fails', async () => {
    const { runtime, state, store, execute } = fixture();
    const now = Date.parse('2026-10-15T00:00:00Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    state.jobs.push(sampleJob(now));
    const lastChecked = state.jobs[0].lastCheckedAt;
    store.save.mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(runtime.tick()).rejects.toThrow('disk full');
      expect(state.runs).toHaveLength(0);
      expect(state.occurrences).toHaveLength(0);
      expect(state.jobs[0].lastCheckedAt).toBe(lastChecked);
      expect(execute).not.toHaveBeenCalled();
      await runtime.tick();
      expect(state.runs).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('freezes the queued job output/scope/skill and records an inactive skill mismatch as skipped', async () => {
    const { runtime, state, execute } = fixture();
    const now = Date.parse('2026-10-15T00:00:00Z');
    vi.spyOn(Date, 'now').mockReturnValue(now);
    state.jobs.push(sampleJob(now));
    try {
      await runtime.tick();
      state.jobs[0].outputPath = 'Changed/{date}.md';
      state.jobs[0].scope.push('Private');
      runtime.skill = { ...runtime.skill, instructions: 'changed' };
      await Promise.resolve();
      expect(execute.mock.calls[0][4]).toBe('Daily/{date}.md');
      expect(state.runs[0].scope).toEqual(['Work']);
      expect((execute.mock.calls[0][3] as { instructions: string }).instructions).not.toBe(
        'changed',
      );
      const other = fixture();
      other.state.jobs.push({ ...sampleJob(now), skillId: 'unapproved' });
      await other.runtime.tick();
      expect(other.state.runs).toHaveLength(0);
      expect(other.state.occurrences[0].state).toBe('skipped');
    } finally {
      vi.restoreAllMocks();
    }
  });
});
describe('runtime GitHub freshness', () => {
  it('requires current remote revalidation and updates changed hashes', async () => {
    const { runtime, state, settings } = fixture();
    settings.policy.githubRepos = ['acme/work'];
    state.github.push({
      repo: 'acme/work',
      status: 'success',
      documents: [structuredClone(source)],
    });
    expect(await runtime.resolve(source)).toBeNull();
    runtime.revalidateGithub = async (doc) => ({ ...doc, hash: 'v2', text: 'changed' });
    expect((await runtime.resolve(source))?.hash).toBe('v2');
    expect(state.github[0].documents[0].text).toBe('changed');
  });
  it('purges revoked repo cache and index and never reuses stale evidence on transport failure', async () => {
    const { runtime, state, settings } = fixture();
    settings.policy.githubRepos = ['acme/work'];
    state.github.push({
      repo: 'acme/work',
      status: 'success',
      documents: [structuredClone(source)],
    });
    await runtime.index.upsert(source);
    runtime.revalidateGithub = async () => {
      throw new Error('offline');
    };
    expect(await runtime.resolve(source)).toBeNull();
    expect(state.github[0].status).toBe('partial');
    runtime.revalidateGithub = async () => null;
    expect(await runtime.resolve(source)).toBeNull();
    expect(state.github[0].status).toBe('blocked');
    expect(state.github[0].documents).toEqual([]);
    expect(state.index.chunks).toEqual([]);
  });
  it('rechecks current scope after an in-flight GitHub refresh', async () => {
    const { runtime, state, settings } = fixture();
    settings.policy.githubRepos = ['acme/work'];
    state.github.push({
      repo: 'acme/work',
      status: 'success',
      documents: [structuredClone(source)],
    });
    runtime.revalidateGithub = async (doc) => {
      settings.policy.githubRepos = [];
      return doc;
    };
    expect(await runtime.resolve(source)).toBeNull();
    expect(state.github[0].documents).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import type { SourceDocument, VaultPort, Run } from '../packages/contracts';
import type { ChatGPTAuth, GenerationRequest, SecretStore } from '../packages/providers';
import { hashText, isReadable } from '../packages/core';
import { emptyState, type JsonStateStore } from '../packages/storage';
const mocks = vi.hoisted(() => ({ generate: vi.fn(), port: undefined as unknown as VaultPort }));
vi.mock('../packages/obsidian', () => ({
  ObsidianVaultPort: class {
    constructor() {
      return mocks.port;
    }
  },
}));
vi.mock('../packages/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../packages/providers')>()),
  createGenerationProvider: () => ({ id: 'generation', target: 'local', generate: mocks.generate }),
}));
import { HarnessRuntime } from '../apps/obsidian-plugin/runtime';
import { DEFAULT_SETTINGS } from '../apps/obsidian-plugin/settings';
import { getDestination } from '../packages/providers';

const date = '2026-10-15',
  sourcePath = 'Work/standup.md',
  targetPath = `Daily/${date}.md`;
const original =
  '---\ntags: [daily]\ncustom: keep\n---\n# My handwritten plan\n\n- [ ] Keep this task untouched\n';
const sourceText =
  '# 검증\n2026-10-15에 watchdog 회귀 검사를 완료했다. 다음 단계는 업무 PC 검증이다.';
function fixture(withSource = true) {
  const settings = structuredClone(DEFAULT_SETTINGS),
    state = emptyState('00000000-0000-4000-8000-000000000001');
  settings.generation.enabled = true;
  settings.generation.model = 'test-model';
  settings.policy.readPaths = ['Work'];
  settings.policy.writePaths = ['Daily'];
  settings.policy.transfers = [
    {
      destination: getDestination(settings.generation),
      paths: ['Work'],
      githubRepos: [],
      allowUserInput: true,
    },
  ];
  const files = new Map<string, string>([[targetPath, original]]);
  if (withSource) files.set(sourcePath, sourceText);
  const writes: string[] = [];
  const document = (): SourceDocument => ({
    id: `vault:${sourcePath}`,
    kind: 'vault',
    path: sourcePath,
    uri: `obsidian://open?path=${encodeURIComponent(sourcePath)}`,
    title: 'standup',
    text: files.get(sourcePath)!,
    hash: hashText(files.get(sourcePath)!),
    project: 'Alpha',
    tags: ['work'],
    updatedAt: Date.parse(`${date}T09:00:00+09:00`),
    indexedAt: Date.now(),
  });
  const port: VaultPort = {
    list: async () =>
      files.has(sourcePath) && isReadable(settings.policy, { kind: 'vault', path: sourcePath })
        ? [document()]
        : [],
    read: async (path) => files.get(path) ?? null,
    apply: async (path, base, after) => {
      if (hashText(files.get(path) ?? null) !== base) throw new Error('atomic conflict');
      writes.push(path);
      files.set(path, after);
    },
    isOpen: () => false,
  };
  mocks.port = port;
  const store = {
    state,
    readOnly: false,
    save: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const secrets: SecretStore = {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
  };
  const runtime = new HarnessRuntime(
    {} as App,
    store as unknown as JsonStateStore,
    () => settings,
    secrets,
    {} as ChatGPTAuth,
    () => {},
  );
  return { settings, state, files, writes, port, store, runtime, document };
}
function grounded(request: GenerationRequest) {
  const context = JSON.parse(request.messages.find((message) => message.role === 'user')!.content);
  const id: string = context.untrustedEvidence[0].id;
  return {
    text: JSON.stringify({
      projects: [
        {
          name: 'Alpha',
          activity: [{ text: '2026-10-15 watchdog 회귀 검사를 완료했다.', sources: [id] }],
          openItems: [],
          suggestedNextActions: [{ text: '업무 PC에서 추가 검증한다.', sources: [id] }],
          uncertainties: [],
          sources: [id],
        },
      ],
    }),
    usage: { inputTokens: 200, outputTokens: 100 },
  };
}
async function finish(runtime: HarnessRuntime, mode: 'daily' | 'answer' = 'daily'): Promise<Run> {
  const run = await runtime.enqueue({ query: 'watchdog 업무 정리', date, mode });
  await vi.waitFor(() => expect(runtime.controllers.has(run.id)).toBe(false), {
    timeout: 2000,
    interval: 5,
  });
  return run;
}
beforeEach(() => {
  mocks.generate.mockReset();
  mocks.generate.mockImplementation(async (request) => grounded(request));
});

describe('actual Runtime workflow with isolated Vault and provider ports', () => {
  it('returns an explicit insufficient-evidence result without generation or a file change', async () => {
    const { runtime, files, state, writes } = fixture(false);
    const run = await finish(runtime);
    expect(run.state).toBe('SUCCEEDED');
    expect(run.answer).toContain('충분한 근거');
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(state.changes).toHaveLength(0);
    expect(writes).toEqual([]);
    expect(files.get(targetPath)).toBe(original);
  });
  it('prepares a grounded daily change, keeps the original untouched until approval, and preserves handwritten content', async () => {
    const { runtime, files, state, writes } = fixture();
    const run = await finish(runtime);
    expect(run.state).toBe('WAITING_APPROVAL');
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(files.get(targetPath)).toBe(original);
    expect(writes).toEqual([]);
    const change = state.changes[0];
    expect(change.sourceRefs).toHaveLength(1);
    expect(change.after).toContain('watchdog 회귀 검사');
    await runtime.apply(change.id, change.patchHash);
    expect(run.state).toBe('SUCCEEDED');
    expect(change.status).toBe('applied');
    expect(writes).toEqual([targetPath]);
    expect(files.get(targetPath)?.startsWith(original)).toBe(true);
    expect(files.get(targetPath)?.match(/harness:daily-work-review:start/g)).toHaveLength(1);
    expect(state.intents[0].state).toBe('applied');
  });
  it.each(['source', 'target'] as const)(
    'blocks approval after the %s changes and does not overwrite either file',
    async (changed) => {
      const { runtime, state, files, writes } = fixture();
      const run = await finish(runtime);
      const change = state.changes[0];
      const path = changed === 'source' ? sourcePath : targetPath;
      files.set(path, 'edited by the user');
      await expect(runtime.apply(change.id, change.patchHash)).rejects.toThrow();
      expect(run.state).toBe('BLOCKED');
      expect(files.get(path)).toBe('edited by the user');
      expect(writes).toEqual([]);
    },
  );
  it('denies generation when read permission is present but model transfer is revoked', async () => {
    const { runtime, settings, files, state } = fixture();
    settings.policy.transfers = [];
    const run = await finish(runtime);
    expect(run.state).toBe('BLOCKED');
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(state.changes).toHaveLength(0);
    expect(files.get(targetPath)).toBe(original);
  });
  it('allows one JSON correction and fails after a second malformed result without creating a change', async () => {
    const { runtime, files, state } = fixture();
    mocks.generate.mockResolvedValue({
      text: 'not JSON',
      usage: { inputTokens: 200, outputTokens: 5 },
    });
    const run = await finish(runtime);
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(run.state).toBe('FAILED');
    expect(state.changes).toHaveLength(0);
    expect(files.get(targetPath)).toBe(original);
  });
  it('recovers from one malformed JSON result using a fresh valid grounded response', async () => {
    const { runtime, state } = fixture();
    mocks.generate.mockResolvedValueOnce({
      text: 'invalid',
      usage: { inputTokens: 100, outputTokens: 5 },
    });
    const run = await finish(runtime);
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(run.state).toBe('WAITING_APPROVAL');
    expect(state.changes).toHaveLength(1);
  });
  it('cancels an active model request and never performs a correction or writes a note afterward', async () => {
    const { runtime, state, writes } = fixture();
    mocks.generate.mockImplementation(
      (request: GenerationRequest) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(new Error('canceled transport')), {
            once: true,
          });
        }),
    );
    const run = await runtime.enqueue({ query: '업무 정리', date, mode: 'daily' });
    await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    runtime.cancel(run.id);
    await vi.waitFor(() => expect(runtime.controllers.has(run.id)).toBe(false));
    expect(run.state).toBe('CANCELED');
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(state.changes).toHaveLength(0);
    expect(writes).toEqual([]);
  });
  it('includes an allowed GitHub repository despite separate Vault scope and approves refreshed chunk evidence', async () => {
    const { runtime, state, settings, writes } = fixture(false);
    settings.githubEnabled = true;
    settings.policy.githubRepos = ['acme/work'];
    settings.policy.transfers[0].githubRepos = ['acme/work'];
    const github: SourceDocument = {
      id: 'github:issue:1',
      kind: 'github',
      path: 'acme/work/issues/1',
      uri: 'https://github.com/acme/work/issues/1',
      title: 'Watchdog verification',
      hash: hashText(sourceText),
      text: sourceText,
      updatedAt: Date.parse(`${date}T09:00:00+09:00`),
      indexedAt: Date.now(),
      project: 'acme/work',
      tags: [],
    };
    state.github.push({ repo: 'acme/work', status: 'success', documents: [github] });
    runtime.revalidateGithub = async (document) => ({ ...document });
    const run = await finish(runtime);
    expect(run.state).toBe('WAITING_APPROVAL');
    expect(run.evidence[0].kind).toBe('github');
    const change = state.changes[0];
    await runtime.apply(change.id, change.patchHash);
    expect(change.status).toBe('applied');
    expect(writes).toEqual([targetPath]);
  });
  it('preserves a scheduled repository snapshot when broader repositories are enabled later', async () => {
    const { runtime, state, settings } = fixture(false);
    settings.githubEnabled = true;
    settings.policy.readPaths = ['.'];
    settings.policy.githubRepos = ['acme/work', 'acme/later'];
    settings.policy.transfers[0].githubRepos = [...settings.policy.githubRepos];
    for (const repo of settings.policy.githubRepos) {
      const text = repo === 'acme/work' ? sourceText : 'NEWLY_ENABLED_REPO_ONLY_CONTENT';
      state.github.push({
        repo,
        status: 'success',
        documents: [
          {
            id: `github:${repo}:1`,
            kind: 'github',
            path: `${repo}/issues/1`,
            uri: `https://github.com/${repo}/issues/1`,
            title: repo,
            hash: hashText(text),
            text,
            updatedAt: Date.parse(`${date}T09:00:00+09:00`),
            indexedAt: Date.now(),
            project: repo,
            tags: [],
          },
        ],
      });
    }
    runtime.revalidateGithub = async (document) => ({ ...document });
    const savedScope = ['.', 'acme/work'];
    const run = await runtime.enqueue({
      query: '예약 업무 정리',
      date,
      mode: 'daily',
      scope: savedScope,
      job: {
        id: 'snapshot-job',
        version: 1,
        enabled: true,
        frequency: 'daily',
        localTime: '09:00',
        timezone: 'Asia/Seoul',
        deviceId: state.deviceId,
        scope: savedScope,
        outputPath: 'Daily/{date}.md',
        skillId: 'daily-work-review',
        createdAt: Date.now(),
        lastCheckedAt: Date.now(),
        missedRunPolicy: 'latest_once_within_24h',
      },
    });
    await vi.waitFor(() => expect(runtime.controllers.has(run.id)).toBe(false), {
      timeout: 2000,
      interval: 5,
    });
    expect(run.state).toBe('WAITING_APPROVAL');
    expect(run.trigger).toBe('scheduled');
    expect(run.evidence.every((source) => source.path.startsWith('acme/work/'))).toBe(true);
    expect(JSON.stringify(mocks.generate.mock.calls)).not.toContain(
      'NEWLY_ENABLED_REPO_ONLY_CONTENT',
    );
  });
  it('excludes stale confirmed memory before transfer and marks its stored record inactive', async () => {
    const { runtime, state, document } = fixture();
    state.memories.push({
      id: 'stale-memory',
      text: 'STALE_PRIVATE_MEMORY',
      status: 'confirmed',
      scope: ['Work'],
      sourceRefs: [{ ...document(), hash: 'old-hash' }],
      reviewedAt: Date.now(),
    });
    const run = await finish(runtime);
    expect(run.state).toBe('WAITING_APPROVAL');
    expect(JSON.stringify(mocks.generate.mock.calls)).not.toContain('STALE_PRIVATE_MEMORY');
    expect(state.memories[0].status).toBe('inactive');
  });
  it('binds a memory-only source to approval and blocks if that source subsequently changes', async () => {
    const { runtime, state, files, writes } = fixture();
    const memoryPath = 'Work/decision.md';
    files.set(memoryPath, 'Verified team decision');
    const ref = {
      id: 'vault:decision',
      kind: 'vault' as const,
      path: memoryPath,
      uri: 'obsidian://open?path=Work%2Fdecision.md',
      title: 'Decision',
      hash: hashText(files.get(memoryPath)!),
      updatedAt: 100,
      indexedAt: 100,
    };
    state.memories.push({
      id: 'decision',
      text: 'Use the verified decision',
      status: 'confirmed',
      scope: ['Work'],
      sourceRefs: [ref],
      reviewedAt: Date.now(),
    });
    const run = await finish(runtime);
    expect(run.state).toBe('WAITING_APPROVAL');
    expect(state.changes[0].sourceRefs.some((source) => source.id === ref.id)).toBe(true);
    files.set(memoryPath, 'Decision revised');
    await expect(runtime.apply(state.changes[0].id, state.changes[0].patchHash)).rejects.toThrow();
    expect(writes).toEqual([]);
  });
  it('refuses fabricated citation IDs even when JSON is structurally valid', async () => {
    const { runtime, state } = fixture();
    mocks.generate.mockResolvedValue({
      text: JSON.stringify({
        projects: [
          {
            name: 'Alpha',
            activity: [{ text: 'Claim with fabricated source', sources: ['fabricated'] }],
            openItems: [],
            suggestedNextActions: [],
            uncertainties: [],
            sources: ['fabricated'],
          },
        ],
      }),
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    const run = await finish(runtime);
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(run.state).toBe('FAILED');
    expect(state.changes).toEqual([]);
  });
});

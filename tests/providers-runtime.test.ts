import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import type { Evidence } from '../packages/contracts';
import { emptyState, type JsonStateStore } from '../packages/storage';
import { HarnessRuntime } from '../apps/obsidian-plugin/runtime';
import { DEFAULT_SETTINGS } from '../apps/obsidian-plugin/settings';
import {
  getDestination,
  ProviderError,
  type ChatGPTAuth,
  type GenerationResult,
  type SecretStore,
} from '../packages/providers';
const mock = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('../packages/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../packages/providers')>()),
  createGenerationProvider: () => ({ id: 'generation', target: 'local', generate: mock.generate }),
}));
const validText = JSON.stringify({
  facts: [{ text: 'Synthetic fact', sources: ['e1'] }],
  interpretations: [],
  unknowns: [],
});
const validResult: GenerationResult = {
  text: validText,
  finishReason: 'stop',
  usage: { inputTokens: 15, outputTokens: 11 },
};
afterEach(() => {
  vi.useRealTimers();
  mock.generate.mockReset();
});
function fixture() {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.generation.enabled = true;
  settings.generation.model = 'fixture';
  settings.policy.readPaths = ['Work'];
  settings.policy.transfers = [
    {
      destination: getDestination(settings.generation),
      paths: ['Work'],
      githubRepos: [],
      allowUserInput: true,
    },
  ];
  const evidence: Evidence = {
    id: 'e1',
    kind: 'vault',
    uri: 'Work/a.md',
    path: 'Work/a.md',
    title: 'Synthetic',
    text: 'Synthetic fixture record',
    hash: 'fixture-hash',
    updatedAt: Date.now(),
    indexedAt: Date.now(),
    project: 'Work',
    tags: [],
    score: 1,
  };
  const store = {
    state: emptyState(),
    save: async () => {},
    readOnly: false,
  } as unknown as JsonStateStore;
  const app = { vault: { adapter: { getBasePath: () => '/tmp' } } } as unknown as App;
  const secrets: SecretStore = {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
  };
  const runtime = new HarnessRuntime(
    app,
    store,
    () => settings,
    secrets,
    {} as ChatGPTAuth,
    () => {},
  );
  vi.spyOn(runtime, 'refreshIndex').mockResolvedValue();
  vi.spyOn(runtime, 'resolve').mockResolvedValue(evidence);
  vi.spyOn(runtime.index, 'search').mockResolvedValue({ evidence: [evidence], mode: 'hybrid' });
  vi.spyOn(runtime.index, 'context').mockReturnValue([evidence]);
  const enqueue = () =>
    runtime.enqueue({ query: 'Synthetic query', date: '2026-10-15', mode: 'answer' });
  return { runtime, settings, store, enqueue };
}
async function settled(run: { state: string }) {
  await vi.waitFor(
    () => expect(['SUCCEEDED', 'BLOCKED', 'FAILED', 'CANCELED']).toContain(run.state),
    { timeout: 2000, interval: 5 },
  );
}
describe('provider errors through runtime budgets and correction', () => {
  it('corrects malformed provider JSON once and charges rejected output', async () => {
    mock.generate
      .mockRejectedValueOnce(
        new ProviderError('INVALID_RESPONSE', 'Synthetic malformed JSON', false, 0, 7),
      )
      .mockResolvedValue(validResult);
    const f = fixture();
    const run = await f.enqueue();
    await settled(run);
    expect(run.state).toBe('SUCCEEDED');
    expect(run.modelCalls).toBe(2);
    expect(run.outputTokens).toBeGreaterThanOrEqual(7 + validResult.usage!.outputTokens);
    expect(run.outputTokens).toBeGreaterThanOrEqual(7 + Buffer.byteLength(validText, 'utf8'));
    expect(mock.generate.mock.calls[1][0].messages.at(-1).content).toContain('검증에 실패');
  });
  it('does not make a third correction call', async () => {
    mock.generate.mockRejectedValue(
      new ProviderError('INVALID_RESPONSE', 'Synthetic malformed JSON', false, 0, 7),
    );
    const f = fixture();
    const run = await f.enqueue();
    await settled(run);
    expect(run.state).toBe('BLOCKED');
    expect(mock.generate).toHaveBeenCalledTimes(2);
    expect(run.outputTokens).toBe(14);
    expect(run.answer).toBeUndefined();
  });
  it('enforces model budget before a corrective call', async () => {
    mock.generate.mockRejectedValue(
      new ProviderError('INVALID_RESPONSE', 'Synthetic malformed JSON', false, 0, 7),
    );
    const f = fixture();
    f.settings.budget.maxModelCalls = 1;
    const run = await f.enqueue();
    await settled(run);
    expect(run.errorCode).toBe('MODEL_BUDGET');
    expect(mock.generate).toHaveBeenCalledTimes(1);
    expect(run.outputTokens).toBe(7);
  });
  it('corrects schema/evidence failure using the same single allowance', async () => {
    mock.generate
      .mockResolvedValueOnce({ ...validResult, text: validText.replace('e1', 'invented-id') })
      .mockResolvedValue(validResult);
    const f = fixture();
    const run = await f.enqueue();
    await settled(run);
    expect(run.state).toBe('SUCCEEDED');
    expect(run.modelCalls).toBe(2);
    expect(run.outputTokens).toBeGreaterThanOrEqual(2 * validResult.usage!.outputTokens);
    expect(run.outputTokens).toBeGreaterThanOrEqual(
      Buffer.byteLength(validText.replace('e1', 'invented-id'), 'utf8') +
        Buffer.byteLength(validText, 'utf8'),
    );
  });

  it('rejects an oversized output even when the company server reports zero usage', async () => {
    const oversized = JSON.stringify({
      facts: [{ text: '한'.repeat(200), sources: ['e1'] }],
      interpretations: [],
      unknowns: [],
    });
    mock.generate.mockResolvedValue({
      text: oversized,
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const f = fixture();
    f.settings.budget.maxOutputTokens = 128;
    const run = await f.enqueue();
    await settled(run);
    expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(128);
    expect(run.errorCode).toBe('TOKEN_BUDGET');
    expect(run.state).toBe('BLOCKED');
    expect(run.answer).toBeUndefined();
    expect(mock.generate).toHaveBeenCalledTimes(1);
    expect(run.outputTokens).toBeGreaterThan(f.settings.budget.maxOutputTokens);
  });
  it('does not correct authentication failures', async () => {
    mock.generate.mockRejectedValue(
      new ProviderError('AUTH_INVALID', 'Synthetic expired credentials'),
    );
    const f = fixture();
    const run = await f.enqueue();
    await settled(run);
    expect(run.state).toBe('BLOCKED');
    expect(mock.generate).toHaveBeenCalledTimes(1);
  });
  it('honors Retry-After before a transient retry', async () => {
    vi.useFakeTimers();
    mock.generate
      .mockRejectedValueOnce(new ProviderError('RATE_LIMITED', 'Synthetic rate limit', true, 5000))
      .mockResolvedValue(validResult);
    const f = fixture();
    const run = await f.enqueue();
    await vi.advanceTimersByTimeAsync(0);
    expect(mock.generate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(mock.generate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mock.generate).toHaveBeenCalledTimes(2);
    expect(run.state).toBe('SUCCEEDED');
  });

  it('distinguishes request timeout from user cancellation and retries within budget', async () => {
    vi.useFakeTimers();
    mock.generate
      .mockImplementationOnce(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new ProviderError('CANCELLED', 'Synthetic transport abort')),
              { once: true },
            );
          }),
      )
      .mockResolvedValue(validResult);
    const f = fixture();
    f.settings.budget.requestTimeoutMs = 100;
    const run = await f.enqueue();
    await vi.advanceTimersByTimeAsync(100);
    expect(mock.generate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mock.generate).toHaveBeenCalledTimes(2);
    expect(run.state).toBe('SUCCEEDED');
  });
  it('a long Retry-After cannot outlive active run budget', async () => {
    vi.useFakeTimers();
    mock.generate.mockRejectedValue(
      new ProviderError('SERVER', 'Synthetic server busy', true, 60000),
    );
    const f = fixture();
    f.settings.budget.activeTimeoutMs = 3000;
    const run = await f.enqueue();
    await vi.advanceTimersByTimeAsync(3000);
    expect(run.state).toBe('CANCELED');
    expect(mock.generate).toHaveBeenCalledTimes(1);
  });
});

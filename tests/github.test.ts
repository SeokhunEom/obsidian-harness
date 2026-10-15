import { describe, expect, it, vi } from 'vitest';
import { GithubConnector } from '../packages/connect';
import type { GithubSyncState } from '../packages/contracts';
const state = (): GithubSyncState => ({ repo: 'acme/work', status: 'idle', documents: [] });
const item = (number = 1, extra = {}) => ({
  id: number,
  number,
  title: `Task ${number}`,
  body: 'work',
  state: 'open',
  labels: [{ name: 'bug' }],
  assignees: [{ login: 'dev' }],
  updated_at: '2026-10-14T10:00:00Z',
  html_url: `https://github.com/acme/work/issues/${number}`,
  ...extra,
});
const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const config = { apiBase: 'https://api.github.com', repositories: ['acme/work'] };
describe('read-only GitHub connector', () => {
  it('collects issue and PR conversation text, preserves metadata, and never follows response URLs', async () => {
    const seen: string[] = [];
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push(url.pathname);
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('error');
      if (url.pathname.endsWith('/1/comments'))
        return json([
          {
            id: 90,
            body: 'approved plan',
            user: { login: 'lead' },
            updated_at: '2026-10-14T11:00:00Z',
            html_url: 'https://github.com/acme/work/issues/1#issuecomment-90',
          },
        ]);
      if (url.pathname.endsWith('/2/comments')) return json([]);
      return json([
        item(),
        item(2, {
          pull_request: { diff_url: 'https://evil.example/diff' },
          html_url: 'https://github.com/acme/work/pull/2',
        }),
      ]);
    });
    const sync = state();
    await new GithubConnector(config, { canRead: () => true, fetch: transport }).sync(sync);
    expect(sync.status).toBe('success');
    expect(sync.documents).toHaveLength(3);
    expect(sync.documents.find((doc) => doc.title === 'Task 1')?.text).toContain('담당자: dev');
    expect(sync.documents.some((doc) => doc.id.includes(':pull:'))).toBe(true);
    expect(seen.every((path) => path.startsWith('/repos/acme/work/'))).toBe(true);
  });
  it('checkpoints completed pages and resumes after a failure without duplicating sources', async () => {
    let fail = true;
    const calls: string[] = [];
    const transport = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(`${url.searchParams.get('state')}:${url.searchParams.get('page')}`);
      if (url.pathname.endsWith('/comments')) return json([]);
      if (url.searchParams.get('state') === 'open' && url.searchParams.get('page') === '1')
        return json([item()], 200, { link: '<https://evil.example>; rel="next"' });
      if (url.searchParams.get('state') === 'open' && url.searchParams.get('page') === '2' && fail)
        return json({}, 500);
      return json([]);
    });
    const sync = state(),
      connector = new GithubConnector(config, { canRead: () => true, fetch: transport });
    await connector.sync(sync);
    expect(sync.status).toBe('partial');
    expect(JSON.parse(sync.cursor!).page).toBe(2);
    fail = false;
    calls.length = 0;
    await connector.sync(sync);
    expect(calls[0]).toBe('open:2');
    expect(sync.status).toBe('success');
    expect(sync.documents).toHaveLength(1);
  });
  it('blocks and clears cached sources on access revocation without exposing response text or token', async () => {
    const sync = state();
    const transport = vi.fn(async () => json({ token: 'sensitive' }, 403));
    const connector = new GithubConnector(config, {
      canRead: () => true,
      fetch: transport,
      getToken: async () => 'secret',
    });
    await connector.sync(sync);
    expect(sync.status).toBe('blocked');
    expect(sync.documents).toEqual([]);
    expect(JSON.stringify(sync)).not.toMatch(/secret|sensitive/);
    const denied = new GithubConnector(config, { canRead: () => false, fetch: transport });
    await denied.sync(state());
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('persists Retry-After and does not issue an early retry', async () => {
    let now = 100_000;
    const transport = vi.fn(async () => json({}, 429, { 'retry-after': '120' }));
    const sync = state(),
      connector = new GithubConnector(config, {
        canRead: () => true,
        fetch: transport,
        now: () => now,
      });
    await connector.sync(sync);
    expect(sync.message).toContain('120초');
    now += 60_000;
    await connector.sync(sync);
    expect(transport).toHaveBeenCalledTimes(1);
    now += 60_000;
    await connector.sync(sync);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('marks an explicit item cap as partial and rejects unsafe API/source destinations', async () => {
    expect(
      () =>
        new GithubConnector(
          { ...config, apiBase: 'http://api.github.com' },
          { canRead: () => true },
        ),
    ).toThrow();
    const sync = state();
    await new GithubConnector(
      { ...config, maxItems: 1 },
      { canRead: () => true, fetch: async () => json([item(), item(2)]) },
    ).sync(sync);
    expect(sync.status).toBe('partial');
    expect(sync.lastSuccessAt).toBeUndefined();
    expect(sync.documents).toHaveLength(1);
    const bad = state();
    await new GithubConnector(config, {
      canRead: () => true,
      fetch: async () => json([item(1, { html_url: 'https://evil.example/acme/work/issues/1' })]),
    }).sync(bad);
    expect(bad.status).toBe('failed');
    expect(bad.documents).toEqual([]);
  });
  it('revalidates a source version and signals auth/deletion revocation before generation', async () => {
    const sync = state();
    const first = new GithubConnector(config, {
      canRead: () => true,
      fetch: async (input) =>
        new URL(String(input)).pathname.endsWith('/comments') ? json([]) : json([item()]),
    });
    await first.sync(sync);
    const source = sync.documents[0];
    const refresh = new GithubConnector(config, {
      canRead: () => true,
      fetch: async () => json(item(1, { body: 'changed' })),
    });
    expect((await refresh.revalidate(source))?.hash).not.toBe(source.hash);
    const onRevoke = vi.fn(async () => {});
    const deleted = new GithubConnector(config, {
      canRead: () => true,
      fetch: async () => json({}, 404),
      onRevoke,
    });
    expect(await deleted.revalidate(source)).toBeNull();
    expect(onRevoke).toHaveBeenCalledWith('acme/work');
  });
  it('supports an explicit enterprise /api/v3 base without sending credentials elsewhere', async () => {
    const transport = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain('https://git.internal/api/v3/repos/acme/work/');
      return json([]);
    });
    const sync = state();
    await new GithubConnector(
      { ...config, apiBase: 'https://git.internal/api/v3' },
      { canRead: () => true, fetch: transport },
    ).sync(sync);
    expect(sync.status).toBe('success');
  });
});

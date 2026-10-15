import { describe, expect, it, vi } from 'vitest';
import { chunkDocument, conservativeTokens, emptyIndex, SearchIndex } from '../packages/search';
import type { SourceDocument } from '../packages/contracts';
const doc = (id: string, text: string, extra: Partial<SourceDocument> = {}): SourceDocument => ({
  id,
  text,
  kind: 'vault',
  path: `Work/${id}.md`,
  title: id,
  hash: `hash-${text}`,
  updatedAt: 100,
  indexedAt: 100,
  uri: `obsidian://${id}`,
  project: 'Alpha',
  tags: ['work'],
  ...extra,
});
describe('SearchIndex boundaries and retrieval', () => {
  it('splits Korean and oversized fenced code within the byte-token upper bound and preserves locators', () => {
    const document = doc(
      'large',
      '# 제목\n\n' +
        '한국어 문장 '.repeat(600) +
        '\n```c\n' +
        'sem_timedwait(); '.repeat(300) +
        '\n```',
    );
    const chunks = chunkDocument(document);
    expect(chunks.length).toBeGreaterThan(10);
    expect(
      chunks.every((item) => conservativeTokens(item.text) <= 1000 && item.locator?.includes('L')),
    ).toBe(true);
    expect(chunkDocument(document).map((item) => item.id)).toEqual(chunks.map((item) => item.id));
  });
  it('finds punctuation identifiers and Korean substrings, while respecting every filter', async () => {
    const index = new SearchIndex(emptyIndex(), { canRead: () => true });
    await index.upsert(doc('fix', 'sem_timedwait foo::bar #123 교착상태를 수정했다.'));
    await index.upsert(
      doc('other', 'sem_timedwait', { project: 'Beta', path: 'Other/a.md', tags: [] }),
    );
    for (const query of ['sem_timedwait', 'foo::bar', '#123', '교착상태']) {
      const result = await index.search(query, {
        paths: ['Work'],
        project: 'Alpha',
        tags: ['work'],
        kind: 'vault',
        from: 99,
        to: 101,
      });
      expect(result.evidence).toHaveLength(1);
      expect(result.evidence[0].title).toBe('fix');
      expect(result.mode).toBe('keyword-only');
    }
    expect((await index.search('sem_timedwait', { paths: ['Wor'] })).evidence).toHaveLength(0);
  });
  it('reuses unchanged chunk embeddings, retains document identity on rename, and removes deleted sources', async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
    const index = new SearchIndex(emptyIndex(), {
      canRead: () => true,
      canEmbed: () => true,
      canEmbedQuery: () => true,
      embedding: { key: 'model@v1', dimensions: 2, embed },
    });
    const original = doc('one', '# First\nsem_timedwait\n# Second\nunchanged');
    await index.upsert(original);
    await index.embedPending();
    expect(embed).toHaveBeenCalledTimes(2);
    await index.upsert({ ...original, text: '# First\nchanged\n# Second\nunchanged', hash: 'v2' });
    await index.embedPending();
    expect(embed).toHaveBeenCalledTimes(3);
    await index.rename('Work/one.md', { ...original, id: 'newid', path: 'Work/moved.md' });
    expect(index.state.documents[0].id).toBe('one');
    expect(index.state.chunks.every((item) => item.path === 'Work/moved.md')).toBe(true);
    await index.remove('Work/moved.md');
    expect((await index.search('unchanged')).evidence).toEqual([]);
  });
  it('checks embedding grants separately and rechecks revocation after an in-flight request', async () => {
    let read = true,
      transfer = false;
    const embed = vi.fn(async () => {
      transfer = false;
      return [[1, 0]];
    });
    const index = new SearchIndex(emptyIndex(), {
      canRead: () => read,
      canEmbed: () => transfer,
      embedding: { key: 'm', dimensions: 2, embed },
    });
    await index.upsert(doc('one', '자료'));
    await index.embedPending();
    expect(embed).not.toHaveBeenCalled();
    transfer = true;
    await index.embedPending();
    expect(index.state.chunks[0].vector).toBeUndefined();
    read = false;
    expect((await index.search('자료')).evidence).toEqual([]);
    expect(index.state.documents).toEqual([]);
  });
  it('never mixes model revisions/dimensions and checkpoints pause/resume', async () => {
    const state = emptyIndex();
    const deps = {
      canRead: () => true,
      canEmbed: () => true,
      canEmbedQuery: () => true,
      embedding: {
        key: 'm@v1',
        dimensions: 2,
        embed: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])),
      },
      save: vi.fn(async () => {}),
    };
    const first = new SearchIndex(state, deps);
    await first.upsert(doc('one', 'alpha'));
    await first.embedPending();
    expect((await first.search('alpha')).mode).toBe('hybrid');
    const second = new SearchIndex(state, {
      ...deps,
      embedding: { ...deps.embedding, key: 'm@v2', dimensions: 3 },
    });
    expect((await second.search('alpha')).mode).toBe('keyword-only');
    expect(state.chunks[0].vector).toBeUndefined();
    await second.pause();
    await second.embedPending();
    expect(state.paused).toBe(true);
    await second.resume();
    await second.embedPending();
    expect(state.failed).toBe(1);
    expect(deps.save).toHaveBeenCalled();
  });
  it('drops stale source versions before returning evidence and limits document concentration', async () => {
    let current = true;
    const index = new SearchIndex(emptyIndex(), {
      canRead: () => true,
      verify: async () => current,
    });
    for (let n = 0; n < 4; n++)
      await index.upsert(
        doc(`d${n}`, Array.from({ length: 6 }, (_, i) => `# Section ${i}\nalpha`).join('\n')),
      );
    const result = await index.search('alpha');
    expect(result.evidence).toHaveLength(10);
    expect(result.evidence.filter((item) => item.path === 'Work/d0.md')).toHaveLength(3);
    expect(index.context(result)).toHaveLength(8);
    current = false;
    expect((await index.search('alpha')).evidence).toHaveLength(0);
  });
  it('does not leak private paths or a source revoked while freshness verification is pending', async () => {
    let allowed = true;
    const index = new SearchIndex(emptyIndex(), {
      canRead: (source) => allowed && source.path.startsWith('Work/'),
      verify: async () => {
        allowed = false;
        return true;
      },
    });
    await index.upsert(doc('public', 'alpha'));
    await index.upsert(doc('private', 'alpha secret', { path: 'Private/private.md' }));
    expect(index.state.documents).toHaveLength(1);
    expect((await index.search('alpha', { paths: ['.'] })).evidence).toEqual([]);
    await index.invalidatePolicy();
    expect(index.state.documents).toEqual([]);
  });
  it('refreshes a cached source map after in-place source replacement during async verification', async () => {
    const state = emptyIndex();
    const index = new SearchIndex(state, {
      canRead: () => true,
      verify: async () => {
        state.documents[0] = { ...state.documents[0], hash: 'replaced' };
        return true;
      },
    });
    await index.upsert(doc('one', 'alpha'));
    expect((await index.search('alpha')).evidence).toEqual([]);
  });
  it('checks embedding grants again after async freshness verification before transfer', async () => {
    let allowed = true;
    const embed = vi.fn(async () => [[1, 0]]);
    const index = new SearchIndex(emptyIndex(), {
      canRead: () => true,
      canEmbed: () => allowed,
      verify: async () => {
        allowed = false;
        return true;
      },
      embedding: { key: 'model', dimensions: 2, embed },
    });
    await index.upsert(doc('one', 'private material'));
    await index.embedPending();
    expect(embed).not.toHaveBeenCalled();
    expect(index.state.chunks[0].vector).toBeUndefined();
  });
  it('keeps GitHub repository filtering independent from the Vault root path filter', async () => {
    const index = new SearchIndex(emptyIndex(), { canRead: () => true });
    await index.upsert(doc('vault', 'alpha'));
    await index.upsert(
      doc('selected-repo', 'alpha', {
        kind: 'github',
        path: 'a/b/issues/1',
        uri: 'https://github.com/a/b/issues/1',
      }),
    );
    await index.upsert(
      doc('other-repo', 'alpha', {
        kind: 'github',
        path: 'a/c/issues/2',
        uri: 'https://github.com/a/c/issues/2',
      }),
    );
    const vaultOnly = await index.search('alpha', { paths: ['.'], githubRepos: [] });
    expect(vaultOnly.evidence.map((source) => source.title)).toEqual(['vault']);
    const selected = await index.search('alpha', { paths: ['.'], githubRepos: ['a/b'] });
    expect(selected.evidence.map((source) => source.title).sort()).toEqual([
      'selected-repo',
      'vault',
    ]);
    expect(selected.evidence.some((source) => source.path.startsWith('a/c/'))).toBe(false);
  });
  it('fails closed when constructed without current policy callbacks', async () => {
    const index = new SearchIndex(emptyIndex());
    await index.upsert(doc('one', 'secret'));
    expect(index.state.documents).toHaveLength(0);
  });
});

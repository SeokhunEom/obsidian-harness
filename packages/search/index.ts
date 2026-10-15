import { createHash } from 'node:crypto';
import type {
  Evidence,
  IndexState,
  SearchFilter,
  SearchResult,
  SourceDocument,
} from '../contracts';

export interface SearchDependencies {
  canRead(document: SourceDocument): boolean;
  canEmbed?(document: SourceDocument): boolean;
  canEmbedQuery?(query: string): boolean;
  verify?(document: SourceDocument): Promise<boolean>;
  embedding?: {
    key: string;
    dimensions: number;
    embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  };
  save?(): Promise<void>;
}
export const emptyIndex = (): IndexState => ({
  documents: [],
  chunks: [],
  processed: 0,
  pending: 0,
  failed: 0,
  paused: false,
});
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
// UTF-8 byte count is a conservative upper bound for byte-tokenizing providers.
export const conservativeTokens = (text: string): number => Buffer.byteLength(text, 'utf8');
export function chunkDocument(document: SourceDocument): Evidence[] {
  const chunks: Evidence[] = [];
  let buffer = '',
    startLine = 1,
    line = 1,
    heading = '',
    inFence = false;
  const repeats = new Map<string, number>();
  const flush = () => {
    const text = buffer.trim();
    if (text) {
      const key = digest(text),
        occurrence = repeats.get(key) ?? 0;
      repeats.set(key, occurrence + 1);
      const { text: _, ...source } = document;
      chunks.push({
        ...source,
        id: `${document.id}:${key.slice(0, 20)}:${occurrence}`,
        text,
        score: 0,
        locator: `${heading ? `${heading} · ` : ''}L${startLine}`,
        indexedAt: Date.now(),
      });
    }
    buffer = '';
  };
  for (const rawLine of document.text.split('\n')) {
    const isHeading = !inFence && /^#{1,6}\s/.test(rawLine);
    if (isHeading) {
      flush();
      heading = rawLine.replace(/^#+\s*/, '');
    }
    if (/^\s*(```|~~~)/.test(rawLine)) inFence = !inFence;
    if (!buffer) startLine = line;
    // Preserve paragraphs/fences when possible; record the original line for oversized fragments.
    for (const character of `${rawLine}\n`) {
      if (conservativeTokens(buffer + character) > 1000) {
        flush();
        startLine = line;
      }
      buffer += character;
    }
    if (!inFence && !rawLine.trim() && conservativeTokens(buffer) >= 500) flush();
    line++;
  }
  flush();
  return chunks;
}
function within(path: string, root: string): boolean {
  return root === '.' || path === root || path.startsWith(`${root.replace(/\/$/, '')}/`);
}
function matches(item: Evidence, filter: SearchFilter): boolean {
  return (
    (item.kind !== 'github' ||
      filter.githubRepos === undefined ||
      filter.githubRepos.includes(item.path.split('/').slice(0, 2).join('/'))) &&
    (!filter.kind || filter.kind === item.kind) &&
    (!filter.paths?.length || filter.paths.some((path) => within(item.path, path))) &&
    (!filter.project || filter.project === item.project) &&
    (!filter.tags?.length || filter.tags.every((tag) => item.tags.includes(tag))) &&
    (filter.from === undefined || item.updatedAt >= filter.from) &&
    (filter.to === undefined || item.updatedAt <= filter.to)
  );
}
export function keywordScore(query: string, item: Pick<Evidence, 'text' | 'title'>): number {
  const needle = query.normalize('NFKC').toLocaleLowerCase().trim();
  if (!needle) return 0;
  const haystack = `${item.title}\n${item.text}`.normalize('NFKC').toLocaleLowerCase();
  const terms = [...new Set(needle.match(/[\p{L}\p{N}_:#.\-]+/gu) ?? [])];
  let score = haystack.includes(needle) ? 12 : 0;
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += 4;
      continue;
    }
    if (/[가-힣]/.test(term)) {
      const grams = Array.from({ length: Math.max(0, term.length - 1) }, (_, i) =>
        term.slice(i, i + 2),
      );
      score += grams.filter((gram) => haystack.includes(gram)).length / Math.max(grams.length, 1);
    }
  }
  return score;
}
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return -1;
  const dot = a.reduce((sum, value, i) => sum + value * b[i], 0);
  const norm = Math.hypot(...a) * Math.hypot(...b);
  return norm ? dot / norm : -1;
}
function validVector(vector: number[] | undefined, dimensions: number): vector is number[] {
  return (
    !!vector &&
    vector.length === dimensions &&
    vector.every(Number.isFinite) &&
    vector.some((value) => value !== 0)
  );
}
export class SearchIndex {
  private sourceDocuments?: SourceDocument[];
  private sourceCount = -1;
  private sourceMap = new Map<string, SourceDocument>();
  constructor(
    readonly state: IndexState,
    private readonly deps: SearchDependencies = { canRead: () => false },
  ) {}
  private sourceKey(source: Pick<SourceDocument, 'kind' | 'path'>): string {
    return `${source.kind}\0${source.path}`;
  }
  private refreshSourceMap(force = false): void {
    if (
      !force &&
      this.sourceDocuments === this.state.documents &&
      this.sourceCount === this.state.documents.length
    )
      return;
    this.sourceDocuments = this.state.documents;
    this.sourceCount = this.state.documents.length;
    this.sourceMap = new Map(
      this.state.documents.map((document) => [this.sourceKey(document), document]),
    );
  }
  private modelKey(): string | undefined {
    const model = this.deps.embedding;
    return model ? `${model.key}|dimensions=${model.dimensions}|cosine` : undefined;
  }
  private source(chunk: Evidence): SourceDocument | undefined {
    this.refreshSourceMap();
    const document = this.sourceMap.get(this.sourceKey(chunk));
    return document?.hash === chunk.hash ? document : undefined;
  }
  private recount(): void {
    this.state.processed = this.state.chunks.filter(
      (chunk) => chunk.vector && chunk.embeddingKey === this.modelKey(),
    ).length;
    this.state.pending = this.state.chunks.length - this.state.processed;
  }
  private async save(): Promise<void> {
    this.recount();
    await this.deps.save?.();
  }
  async upsert(document: SourceDocument): Promise<void> {
    if (!this.deps.canRead(document)) {
      await this.remove(document.id);
      await this.remove(document.path);
      return;
    }
    const old = this.state.documents.find(
      (item) =>
        item.id === document.id || (item.kind === document.kind && item.path === document.path),
    );
    const doc = { ...document, id: old?.id ?? document.id, indexedAt: Date.now() };
    const previous = this.state.chunks.filter(
      (item) => item.kind === doc.kind && item.path === (old?.path ?? doc.path),
    );
    const cached = new Map(
      previous
        .filter((item) => item.embeddingKey === this.modelKey())
        .map((item) => [digest(item.text), item]),
    );
    const next = chunkDocument(doc).map((item) => {
      const found = cached.get(digest(item.text));
      return found && this.deps.canEmbed?.(doc)
        ? { ...item, vector: found.vector, embeddingKey: found.embeddingKey }
        : item;
    });
    this.state.documents = this.state.documents.filter((item) => item !== old);
    this.state.documents.push(doc);
    this.state.chunks = this.state.chunks.filter((item) => !previous.includes(item)).concat(next);
    this.state.lastSuccessAt = Date.now();
    await this.save();
  }
  async remove(idOrPath: string): Promise<void> {
    const removed = this.state.documents.filter(
      (item) => item.id === idOrPath || item.path === idOrPath,
    );
    this.state.documents = this.state.documents.filter((item) => !removed.includes(item));
    this.state.chunks = this.state.chunks.filter(
      (item) => !removed.some((doc) => doc.kind === item.kind && doc.path === item.path),
    );
    await this.save();
  }
  async rename(oldPath: string, document: SourceDocument): Promise<void> {
    const old = this.state.documents.find(
      (item) => item.path === oldPath && item.kind === document.kind,
    );
    await this.upsert({ ...document, id: old?.id ?? document.id });
  }
  async reconcile(documents: SourceDocument[]): Promise<void> {
    const incoming = new Map(documents.map((document) => [this.sourceKey(document), document]));
    for (const old of [...this.state.documents]) {
      if (!incoming.has(this.sourceKey(old))) await this.remove(old.id);
    }
    this.refreshSourceMap(true);
    const previous = new Map(this.sourceMap);
    for (const doc of documents) {
      const old = previous.get(this.sourceKey(doc));
      if (
        !old ||
        old.hash !== doc.hash ||
        old.title !== doc.title ||
        old.project !== doc.project ||
        old.updatedAt !== doc.updatedAt ||
        JSON.stringify(old.tags) !== JSON.stringify(doc.tags)
      )
        await this.upsert(doc);
    }
    await this.invalidatePolicy();
  }
  async invalidatePolicy(): Promise<void> {
    this.state.documents = this.state.documents.filter((item) => this.deps.canRead(item));
    this.refreshSourceMap(true);
    this.state.chunks = this.state.chunks.filter((item) => !!this.source(item));
    const modelKey = this.modelKey();
    for (const item of this.state.chunks) {
      const source = this.source(item)!;
      if (item.embeddingKey !== modelKey || !this.deps.canEmbed?.(source)) {
        delete item.vector;
        delete item.embeddingKey;
      }
    }
    this.state.embeddingKey = modelKey;
    await this.save();
  }
  async pause(): Promise<void> {
    this.state.paused = true;
    await this.save();
  }
  async resume(): Promise<void> {
    this.state.paused = false;
    await this.save();
  }
  async rebuild(documents = [...this.state.documents]): Promise<void> {
    this.state.documents = [];
    this.state.chunks = [];
    this.state.failed = 0;
    for (const doc of documents) await this.upsert(doc);
    await this.invalidatePolicy();
  }
  async embedPending(signal?: AbortSignal): Promise<void> {
    await this.invalidatePolicy();
    const model = this.deps.embedding;
    if (!model) return;
    const key = this.modelKey();
    this.state.failed = 0;
    for (const chunk of [...this.state.chunks]) {
      if (signal?.aborted || this.state.paused) break;
      const source = this.source(chunk);
      if (
        !source ||
        !this.deps.canRead(source) ||
        !this.deps.canEmbed?.(source) ||
        chunk.embeddingKey === key
      )
        continue;
      try {
        if (this.deps.verify && !(await this.deps.verify(source))) {
          await this.remove(source.id);
          continue;
        }
        this.refreshSourceMap(true);
        if (
          signal?.aborted ||
          this.state.paused ||
          !this.source(chunk) ||
          !this.deps.canRead(source) ||
          !this.deps.canEmbed?.(source)
        )
          continue;
        const vectors = await model.embed([chunk.text], signal);
        if (signal?.aborted) break;
        this.refreshSourceMap(true);
        if (!validVector(vectors[0], model.dimensions)) throw new Error('EMBEDDING_DIMENSION');
        if (
          !this.source(chunk) ||
          !this.state.chunks.includes(chunk) ||
          !this.deps.canRead(source) ||
          !this.deps.canEmbed?.(source) ||
          key !== this.modelKey()
        )
          continue;
        if (this.deps.verify && !(await this.deps.verify(source))) {
          await this.remove(source.id);
          continue;
        }
        this.refreshSourceMap(true);
        if (
          !this.source(chunk) ||
          !this.state.chunks.includes(chunk) ||
          !this.deps.canRead(source) ||
          !this.deps.canEmbed?.(source)
        )
          continue;
        chunk.vector = vectors[0];
        chunk.embeddingKey = key;
        this.state.lastSuccessAt = Date.now();
      } catch {
        if (!signal?.aborted) this.state.failed++;
      }
      await this.save();
    }
    await this.save();
  }
  async search(
    query: string,
    filter: SearchFilter = {},
    options: { signal?: AbortSignal; limit?: number } = {},
  ): Promise<SearchResult> {
    await this.invalidatePolicy();
    if (options.signal?.aborted) throw new Error('CANCELED');
    const eligible = this.state.chunks.filter(
      (item) => matches(item, filter) && this.deps.canRead(this.source(item)!),
    );
    const keyword = eligible
      .map((item) => ({ item, score: keywordScore(query, item) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);
    let vector: typeof keyword = [],
      reason = '임베딩 모델이 설정되지 않았습니다.',
      mode: SearchResult['mode'] = 'keyword-only';
    const model = this.deps.embedding;
    const vectorEligible = eligible.filter((item) => this.deps.canEmbed?.(this.source(item)!));
    if (model) {
      if (!this.deps.canEmbedQuery?.(query))
        reason = '검색 질의의 임베딩 전송이 허용되지 않았습니다.';
      else if (
        !vectorEligible.length ||
        vectorEligible.some(
          (item) =>
            item.embeddingKey !== this.modelKey() || !validVector(item.vector, model.dimensions),
        )
      )
        reason = '허용된 자료의 임베딩 색인이 아직 완료되지 않았습니다.';
      else
        try {
          const [queryVector] = await model.embed([query], options.signal);
          if (!validVector(queryVector, model.dimensions)) throw new Error('EMBEDDING_DIMENSION');
          if (!this.deps.canEmbedQuery?.(query)) throw new Error('POLICY_CHANGED');
          vector = vectorEligible
            .map((item) => ({ item, score: cosine(queryVector, item.vector!) }))
            .filter((item) => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 30);
          mode = 'hybrid';
          reason = '';
        } catch {
          reason = '질의 임베딩에 실패했습니다. 키워드 결과만 표시합니다.';
        }
    }
    const merged = new Map<string, { item: Evidence; score: number }>();
    for (const list of [keyword, vector])
      list.forEach(({ item }, rank) =>
        merged.set(item.id, {
          item,
          score: (merged.get(item.id)?.score ?? 0) + 1 / (60 + rank + 1),
        }),
      );
    const evidence: Evidence[] = [],
      counts = new Map<string, number>(),
      verified = new Map<string, boolean>();
    for (const { item, score } of [...merged.values()].sort((a, b) => b.score - a.score)) {
      if (options.signal?.aborted) throw new Error('CANCELED');
      const source = this.source(item);
      if (!source || !this.deps.canRead(source)) continue;
      if (!verified.has(source.id))
        verified.set(source.id, this.deps.verify ? await this.deps.verify(source) : true);
      this.refreshSourceMap(true);
      if (!verified.get(source.id)) {
        await this.remove(source.id);
        continue;
      }
      if (!this.source(item) || !this.deps.canRead(source) || (counts.get(source.id) ?? 0) >= 3)
        continue;
      counts.set(source.id, (counts.get(source.id) ?? 0) + 1);
      const { vector: _, embeddingKey: __, ...publicItem } = item;
      evidence.push({ ...publicItem, score });
      if (evidence.length >= Math.min(options.limit ?? 10, 10)) break;
    }
    return { evidence, mode, ...(reason ? { reason } : {}) };
  }
  context(result: SearchResult): Evidence[] {
    return result.evidence.slice(0, 8);
  }
}

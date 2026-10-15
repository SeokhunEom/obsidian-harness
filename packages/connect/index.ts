import { createHash } from 'node:crypto';
import type { GithubSyncState, SourceDocument } from '../contracts';

export interface GithubConfig {
  apiBase: string;
  repositories: string[];
  maxItems?: number;
  days?: number;
  timeoutMs?: number;
}
export interface GithubDependencies {
  canRead(repo: string): boolean;
  getToken?(): Promise<string | undefined>;
  fetch?: typeof fetch;
  save?(): Promise<void>;
  now?(): number;
  onRevoke?(repo: string): Promise<void>;
}
interface Cursor {
  phase: 'open' | 'recent' | 'comments';
  page: number;
  commentIndex: number;
  numbers: number[];
  seen: string[];
  since: string;
  items: number;
  retryAt?: number;
}
class GithubError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterMs = 0,
  ) {
    super(code);
  }
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GithubError('INVALID_RESPONSE');
  return value as Record<string, unknown>;
};
const string = (value: unknown): string => (typeof value === 'string' ? value : '');
function checkedNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new GithubError('INVALID_RESPONSE');
  return Number(value);
}
export class GithubConnector {
  private readonly base: URL;
  private readonly maxItems: number;
  private readonly now: () => number;
  constructor(
    private readonly config: GithubConfig,
    private readonly deps: GithubDependencies,
  ) {
    this.base = new URL(config.apiBase);
    if (
      this.base.protocol !== 'https:' ||
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash ||
      /%|\.\./.test(this.base.pathname)
    )
      throw new Error('GitHub API는 인증정보·쿼리가 없는 HTTPS 주소여야 합니다.');
    this.base.pathname = this.base.pathname.replace(/\/$/, '') + '/';
    for (const repo of config.repositories) this.validateRepo(repo);
    this.maxItems = config.maxItems ?? 1000;
    if (!Number.isInteger(this.maxItems) || this.maxItems < 1 || this.maxItems > 1000)
      throw new Error('MVP 수집 상한은 저장소당 1~1,000개입니다.');
    if (
      config.days !== undefined &&
      (!Number.isInteger(config.days) || config.days < 1 || config.days > 30)
    )
      throw new Error('MVP 수집 기간은 1~30일입니다.');
    this.now = deps.now ?? Date.now;
  }
  private validateRepo(repo: string): void {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
      repo.split('/').some((part) => part === '.' || part === '..')
    )
      throw new Error('저장소는 owner/repo 형식이어야 합니다.');
  }
  private allowed(repo: string): void {
    this.validateRepo(repo);
    if (!this.config.repositories.includes(repo) || !this.deps.canRead(repo))
      throw new GithubError('ACCESS_REVOKED');
  }
  private async request(
    repo: string,
    suffix: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ body: unknown; more: boolean }> {
    this.allowed(repo);
    const url = new URL(`repos/${repo}${suffix}`, this.base);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname))
      throw new GithubError('DESTINATION_BLOCKED');
    const controller = new AbortController(),
      onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(this.config.timeoutMs ?? 30_000, 60_000),
    );
    try {
      const token = await this.deps.getToken?.();
      this.allowed(repo);
      if (controller.signal.aborted) throw new GithubError('CANCELED');
      const response = await (this.deps.fetch ?? fetch)(url.toString(), {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      this.allowed(repo);
      if (response.redirected || (response.status >= 300 && response.status < 400))
        throw new GithubError('REDIRECT_BLOCKED');
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.has('retry-after') ||
            response.headers.get('x-ratelimit-remaining') === '0'))
      ) {
        const after = response.headers.get('retry-after'),
          reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
        const retryAfter = after
          ? /^\d+(\.\d+)?$/.test(after)
            ? Number(after) * 1000
            : Date.parse(after) - this.now()
          : reset - this.now();
        throw new GithubError(
          'RATE_LIMIT',
          Math.max(60_000, Number.isFinite(retryAfter) ? retryAfter : 0),
        );
      }
      if ([401, 403, 404, 410].includes(response.status)) throw new GithubError('ACCESS_REVOKED');
      if (response.status >= 500) throw new GithubError('SERVER_ERROR');
      if (!response.ok) throw new GithubError('REQUEST_FAILED');
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > 8 * 1024 * 1024) throw new GithubError('RESPONSE_TOO_LARGE');
      let bytes = 0;
      const reader = response.body?.getReader(),
        decoder = new TextDecoder(),
        pieces: string[] = [];
      if (!reader) throw new GithubError('INVALID_RESPONSE');
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 8 * 1024 * 1024) {
          await reader.cancel();
          throw new GithubError('RESPONSE_TOO_LARGE');
        }
        pieces.push(decoder.decode(value, { stream: true }));
      }
      pieces.push(decoder.decode());
      this.allowed(repo);
      return {
        body: JSON.parse(pieces.join('')),
        more: /rel="next"/.test(response.headers.get('link') ?? ''),
      };
    } catch (error) {
      if (error instanceof GithubError) throw error;
      throw new GithubError(
        signal?.aborted ? 'CANCELED' : controller.signal.aborted ? 'TIMEOUT' : 'NETWORK',
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  async probe(
    repo: string,
    signal?: AbortSignal,
  ): Promise<{ repo: string; accessible: boolean; message: string }> {
    try {
      await this.request(repo, '', {}, signal);
      await this.request(repo, '/issues', { state: 'open', per_page: '1' }, signal);
      return {
        repo,
        accessible: true,
        message: '저장소와 Issue/PR 읽기 API에 접근할 수 있습니다.',
      };
    } catch {
      return {
        repo,
        accessible: false,
        message: '저장소 범위·토큰의 읽기 권한·연결을 확인하세요.',
      };
    }
  }
  private parseDocument(repo: string, value: unknown, commentNumber?: number): SourceDocument {
    const item = record(value),
      externalId = checkedNumber(item.id);
    const isComment = commentNumber !== undefined;
    const number = commentNumber ?? checkedNumber(item.number);
    const title = isComment ? `${repo} #${number} 댓글` : string(item.title);
    const labels = Array.isArray(item.labels)
      ? item.labels
          .map((label) => (typeof label === 'string' ? label : string(record(label).name)))
          .filter(Boolean)
      : [];
    const assignees = Array.isArray(item.assignees)
      ? item.assignees.map((value) => string(record(value).login)).filter(Boolean)
      : [];
    const type = isComment ? 'comment' : item.pull_request ? 'pull' : 'issue';
    const text = isComment
      ? `${title}\n작성자: ${item.user ? string(record(item.user).login) : ''}\n${string(item.body)}`
      : `# ${title}\n유형: ${type}\n상태: ${string(item.state)}\n담당자: ${assignees.join(', ')}\n라벨: ${labels.join(', ')}\n수정 시각: ${string(item.updated_at)}\n\n${string(item.body)}`;
    const uri = new URL(string(item.html_url));
    const websiteHost = this.base.hostname === 'api.github.com' ? 'github.com' : this.base.hostname;
    if (
      uri.protocol !== 'https:' ||
      uri.hostname !== websiteHost ||
      uri.username ||
      uri.password ||
      !uri.pathname.startsWith(`/${repo}/`)
    )
      throw new GithubError('INVALID_SOURCE_URL');
    const updatedAt = Date.parse(string(item.updated_at));
    if (!Number.isFinite(updatedAt)) throw new GithubError('INVALID_RESPONSE');
    return {
      id: `github:${this.base.origin}:${repo}:${type}:${externalId}`,
      kind: 'github',
      uri: uri.toString(),
      path: `${repo}/issues/${number}${isComment ? `/comments/${externalId}` : ''}`,
      title,
      text,
      hash: hash(text),
      updatedAt,
      indexedAt: this.now(),
      locator: isComment ? `comment:${externalId}` : `#${number}`,
      project: repo,
      tags: labels,
    };
  }
  /** Refresh a cached source before it is used as model evidence. Null means its repo must be blocked. */
  async revalidate(document: SourceDocument, signal?: AbortSignal): Promise<SourceDocument | null> {
    const match = /^([^/]+\/[^/]+)\/issues\/(\d+)(?:\/comments\/(\d+))?$/.exec(document.path);
    if (document.kind !== 'github' || !match) throw new Error('INVALID_SOURCE');
    const [, repo, number, commentId] = match;
    try {
      const response = await this.request(
        repo,
        commentId ? `/issues/comments/${commentId}` : `/issues/${number}`,
        {},
        signal,
      );
      return this.parseDocument(repo, response.body, commentId ? Number(number) : undefined);
    } catch (error) {
      if (error instanceof GithubError && error.code === 'ACCESS_REVOKED') {
        await this.deps.onRevoke?.(repo);
        return null;
      }
      throw new Error(error instanceof GithubError ? error.code : 'REVALIDATION_FAILED');
    }
  }
  private initialCursor(): Cursor {
    return {
      phase: 'open',
      page: 1,
      commentIndex: 0,
      numbers: [],
      seen: [],
      since: new Date(this.now() - (this.config.days ?? 30) * 86_400_000).toISOString(),
      items: 0,
    };
  }
  private readCursor(raw: string | undefined): Cursor {
    if (!raw) return this.initialCursor();
    try {
      const cursor = JSON.parse(raw) as Cursor;
      if (
        !['open', 'recent', 'comments'].includes(cursor.phase) ||
        !Number.isInteger(cursor.page) ||
        cursor.page < 1 ||
        !Number.isInteger(cursor.commentIndex) ||
        cursor.commentIndex < 0 ||
        !Array.isArray(cursor.numbers) ||
        !cursor.numbers.every((n) => Number.isInteger(n) && n > 0) ||
        !Array.isArray(cursor.seen) ||
        !cursor.seen.every((id) => typeof id === 'string') ||
        !Number.isFinite(Date.parse(cursor.since)) ||
        !Number.isInteger(cursor.items) ||
        cursor.items < 0
      )
        throw new Error();
      return cursor;
    } catch {
      throw new GithubError('CHECKPOINT_INVALID');
    }
  }
  async sync(state: GithubSyncState, signal?: AbortSignal): Promise<GithubSyncState> {
    let cursor: Cursor | undefined;
    try {
      this.allowed(state.repo);
      cursor = this.readCursor(state.cursor);
      if (cursor.retryAt && cursor.retryAt > this.now())
        throw new GithubError('RATE_LIMIT', cursor.retryAt - this.now());
      delete cursor.retryAt;
      state.status = 'syncing';
      state.message = undefined;
      await this.deps.save?.();
      for (;;) {
        if (signal?.aborted) throw new GithubError('CANCELED');
        if (cursor.phase === 'comments' && cursor.commentIndex >= cursor.numbers.length) break;
        const params: Record<string, string> = { per_page: '100', page: String(cursor.page) };
        const number =
          cursor.phase === 'comments' ? cursor.numbers[cursor.commentIndex] : undefined;
        if (cursor.phase !== 'comments') {
          params.state = cursor.phase === 'open' ? 'open' : 'all';
          params.sort = 'updated';
          params.direction = 'desc';
          if (cursor.phase === 'recent') params.since = cursor.since;
        }
        const result = await this.request(
          state.repo,
          number ? `/issues/${number}/comments` : '/issues',
          params,
          signal,
        );
        if (!Array.isArray(result.body)) throw new GithubError('INVALID_RESPONSE');
        const documents = result.body.map((item) => this.parseDocument(state.repo, item, number));
        this.allowed(state.repo);
        // Apply a page only after parsing/validating the entire response.
        for (const doc of documents) {
          if (!cursor.seen.includes(doc.id)) {
            if (cursor.items >= this.maxItems) {
              state.status = 'partial';
              state.message = `수집 상한 ${this.maxItems}개에 도달했습니다. 범위를 줄인 뒤 다시 동기화하세요.`;
              state.cursor = undefined;
              await this.deps.save?.();
              return state;
            }
            cursor.seen.push(doc.id);
            cursor.items++;
          }
          state.documents = state.documents.filter((old) => old.id !== doc.id);
          state.documents.push(doc);
          if (number === undefined) {
            const issueNumber = Number(doc.path.split('/')[3]);
            if (!cursor.numbers.includes(issueNumber)) cursor.numbers.push(issueNumber);
          }
        }
        if (result.more || result.body.length === 100) cursor.page++;
        else {
          cursor.page = 1;
          if (cursor.phase === 'open') cursor.phase = 'recent';
          else if (cursor.phase === 'recent') cursor.phase = 'comments';
          else cursor.commentIndex++;
        }
        state.cursor = JSON.stringify(cursor);
        await this.deps.save?.();
      }
      this.allowed(state.repo);
      state.documents = state.documents.filter((doc) => cursor!.seen.includes(doc.id));
      state.lastSuccessAt = this.now();
      state.status = 'success';
      state.cursor = undefined;
      state.message = '열린 항목과 최근 변경 항목, 해당 댓글 동기화를 완료했습니다.';
    } catch (error) {
      const code = error instanceof GithubError ? error.code : 'SYNC_FAILED';
      if (code === 'ACCESS_REVOKED') {
        state.documents = [];
        state.cursor = undefined;
        state.status = 'blocked';
        await this.deps.onRevoke?.(state.repo);
        state.message = '접근 권한이 없거나 철회되었습니다. 해당 캐시는 사용할 수 없습니다.';
      } else {
        state.status = cursor?.items ? 'partial' : 'failed';
        if (cursor) {
          if (code === 'RATE_LIMIT' && error instanceof GithubError)
            cursor.retryAt = this.now() + error.retryAfterMs;
          state.cursor = JSON.stringify(cursor);
        }
        state.message =
          code === 'RATE_LIMIT' && error instanceof GithubError
            ? `호출 제한: 최소 ${Math.ceil(error.retryAfterMs / 1000)}초 후 다시 시도하세요. 최신성 미확인.`
            : `${code}: 동기화가 완료되지 않았습니다. 최신성 미확인.`;
      }
    }
    await this.deps.save?.();
    return state;
  }
  async revoke(state: GithubSyncState): Promise<void> {
    state.documents = [];
    state.cursor = undefined;
    state.status = 'blocked';
    state.message = '연동이 해제되어 캐시를 정리했습니다.';
    await this.deps.save?.();
  }
}

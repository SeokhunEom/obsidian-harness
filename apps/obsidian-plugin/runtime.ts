import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { App } from 'obsidian';
import type {
  Run,
  Evidence,
  SourceRef,
  SourceDocument,
  SearchFilter,
  SearchResult,
  Skill,
  Job,
  Occurrence,
} from '../../packages/contracts';
import {
  ChangeManager,
  RunGuard,
  ToolRegistry,
  assertRead,
  assertTransfer,
  hashText,
  isReadable,
  PolicyError,
} from '../../packages/core';
import { JsonStateStore } from '../../packages/storage';
import { ObsidianVaultPort } from '../../packages/obsidian';
import { SearchIndex } from '../../packages/search';
import { collectDueOccurrences, SingleRunQueue, zonedOccurrence } from '../../packages/tasks';
import {
  createGenerationProvider,
  createEmbeddingProvider,
  getDestination,
  ProviderError,
} from '../../packages/providers';
import type { ChatGPTAuth, SecretStore } from '../../packages/providers';
import {
  BUILTIN_SKILL,
  INSTRUCTIONS,
  REVIEW_JSON_SCHEMA,
  ANSWER_JSON_SCHEMA,
  buildContext,
  estimateTokens,
  parseJSON,
  validateReview,
  renderReview,
  renderAnswer,
  selectMemories,
} from '../../packages/agent';
import { dailyTarget, type HarnessSettings } from './settings';

export class HarnessRuntime {
  readonly vault: ObsidianVaultPort;
  readonly changes: ChangeManager;
  index: SearchIndex;
  readonly controllers = new Map<string, AbortController>();
  private queue = new SingleRunQueue(10);
  private tickBusy = false;
  private closing = false;
  private pendingWork = new Set<Promise<unknown>>();
  private indexing: Promise<void> | null = null;
  private embeddingController: AbortController | null = null;
  skill: Skill = BUILTIN_SKILL;
  syncGithub?: (signal?: AbortSignal) => Promise<void>;
  revalidateGithub?: (document: SourceDocument) => Promise<SourceDocument | null>;
  beforeRun?: () => Promise<void>;
  constructor(
    readonly app: App,
    readonly store: JsonStateStore,
    readonly settings: () => HarnessSettings,
    readonly secrets: SecretStore,
    readonly auth: ChatGPTAuth,
    readonly onChange: () => void,
  ) {
    this.vault = new ObsidianVaultPort(app, () => settings().policy);
    this.changes = new ChangeManager(
      store,
      this.vault,
      () => settings().policy,
      (ref) => this.resolve(ref),
    );
    this.index = this.makeIndex();
  }
  makeIndex(): SearchIndex {
    const config = structuredClone(this.settings().embedding);
    let embedding:
      | {
          key: string;
          dimensions: number;
          embed: (texts: string[], signal?: AbortSignal) => Promise<number[][]>;
        }
      | undefined;
    if (
      !this.store.readOnly &&
      config.enabled &&
      config.model &&
      this.settings().embeddingDimensions > 0
    ) {
      const provider = createEmbeddingProvider(config, this.secrets);
      embedding = {
        key: getDestination(config),
        dimensions: this.settings().embeddingDimensions,
        embed: (texts, signal) => provider.embed(texts, signal),
      };
    }
    const canTransfer = (refs: SourceRef[], userInput: boolean) => {
      try {
        if (this.closing || getDestination(config) !== getDestination(this.settings().embedding))
          return false;
        assertTransfer(this.settings().policy, refs, getDestination(config), userInput);
        return true;
      } catch {
        return false;
      }
    };
    return new SearchIndex(this.store.state.index, {
      canRead: (d) =>
        isReadable(this.settings().policy, d) &&
        (d.kind !== 'github' ||
          this.store.state.github.some(
            (s) => s.status !== 'blocked' && s.repo === d.path.split('/').slice(0, 2).join('/'),
          )),
      canEmbed: (d) => canTransfer([d], false),
      canEmbedQuery: () => canTransfer([], true),
      verify: async (d) => (await this.resolve(d))?.hash === d.hash,
      embedding,
      save: () => (this.store.readOnly ? Promise.resolve() : this.save()),
    });
  }
  async save(): Promise<void> {
    await this.store.save();
    this.onChange();
  }
  async initialize(): Promise<void> {
    await this.changes.recover();
    this.onChange();
  }
  async policyChanged(): Promise<void> {
    this.cancelAll();
    this.index = this.makeIndex();
    await this.index.invalidatePolicy();
    if (!this.store.readOnly) await this.save();
    else this.onChange();
  }
  async resolve(ref: SourceRef): Promise<SourceRef | null> {
    if (!isReadable(this.settings().policy, ref)) return null;
    if (ref.kind === 'vault') {
      try {
        const text = await this.vault.read(ref.path);
        return text === null ? null : { ...ref, hash: hashText(text) };
      } catch {
        return null;
      }
    }
    const state = this.store.state.github.find(
      (s) => s.repo === ref.path.split('/').slice(0, 2).join('/') && s.status !== 'blocked',
    );
    const doc = state?.documents.find((d) => d.uri === ref.uri);
    if (this.store.readOnly || !state || !doc || !this.revalidateGithub) return null;
    try {
      const fresh = await this.revalidateGithub(doc);
      // The permission may change while a network request is pending.
      if (!fresh || !isReadable(this.settings().policy, fresh)) {
        state.status = 'blocked';
        state.documents = [];
        state.cursor = undefined;
        state.message =
          '접근 권한이 철회되었거나 원문을 확인할 수 없어 해당 저장소 자료를 차단했습니다.';
        this.store.state.index.documents = this.store.state.index.documents.filter(
          (d) => d.kind !== 'github' || d.path.split('/').slice(0, 2).join('/') !== state.repo,
        );
        this.store.state.index.chunks = this.store.state.index.chunks.filter(
          (d) => d.kind !== 'github' || d.path.split('/').slice(0, 2).join('/') !== state.repo,
        );
        await this.save();
        return null;
      }
      if (fresh.id !== doc.id || fresh.uri !== doc.uri || fresh.path !== doc.path) return null;
      state.documents = state.documents.map((d) => (d.id === doc.id ? fresh : d));
      await this.save();
      return { ...fresh, id: ref.id, locator: ref.locator };
    } catch {
      if (state.status !== 'blocked') {
        state.status = state.documents.length ? 'partial' : 'failed';
        state.message = '원문 재검증 실패 · 최신성 미확인. 연결을 확인한 뒤 다시 실행하세요.';
        await this.save();
      }
      return null;
    }
  }
  async refreshIndex(): Promise<void> {
    if (this.store.readOnly || this.closing) return;
    if (this.indexing) return this.indexing;
    this.indexing = (async () => {
      const docs = await this.vault.list();
      const github = this.store.state.github
        .filter((s) => s.status !== 'blocked')
        .flatMap((s) => s.documents)
        .filter((d) => isReadable(this.settings().policy, d));
      await this.index.reconcile([...docs, ...github]);
    })();
    try {
      await this.indexing;
    } finally {
      this.indexing = null;
    }
  }
  async embedIndex(): Promise<void> {
    if (this.closing || this.settings().paused || this.store.readOnly)
      throw new Error('PAUSED: 색인 작업이 비활성입니다.');
    if (this.embeddingController) throw new Error('INDEX_BUSY: 임베딩 작업이 진행 중입니다.');
    this.embeddingController = new AbortController();
    const work = (async () => {
      await this.index.resume();
      await this.index.embedPending(this.embeddingController!.signal);
    })();
    this.pendingWork.add(work);
    try {
      await work;
    } finally {
      this.pendingWork.delete(work);
      this.embeddingController = null;
      this.onChange();
    }
  }
  async pauseIndex(): Promise<void> {
    this.embeddingController?.abort();
    await this.index.pause();
    this.onChange();
  }
  async search(query: string, filter: SearchFilter = {}): Promise<SearchResult> {
    if (this.settings().paused) throw new Error('PAUSED: 설정에서 전체 일시정지를 해제하세요.');
    await this.refreshIndex();
    return this.index.search(query, filter);
  }
  async enqueue(input: {
    query: string;
    date: string;
    mode: 'answer' | 'daily' | 'draft';
    scope?: string[];
    parentRunId?: string;
    job?: Job;
    occurrence?: Occurrence;
  }): Promise<Run> {
    if (this.closing || this.settings().paused || this.store.readOnly)
      throw new Error('PAUSED: 실행이 일시정지되었거나 저장소가 읽기 전용입니다.');
    if (!input.query.trim()) throw new Error('INPUT: 요청을 입력하세요.');
    dailyTarget(this.settings().dailyPath, input.date);
    await this.beforeRun?.();
    if (this.settings().paused || this.store.readOnly)
      throw new Error('PAUSED: 실행 준비 중 설정이 변경되었습니다.');
    const policy = this.settings().policy;
    const skill = structuredClone(this.skill),
      job = input.job ? structuredClone(input.job) : undefined;
    if (job && job.skillId !== skill.id)
      throw new Error(
        'SKILL_CHANGED: 예약의 Skill과 현재 활성 Skill이 다릅니다. 예약을 검토하세요.',
      );
    if (
      input.occurrence &&
      (this.store.state.occurrences.some((o) => o.key === input.occurrence!.key) ||
        this.store.state.runs.some((r) => r.occurrenceKey === input.occurrence!.key))
    )
      throw new Error('DUPLICATE_OCCURRENCE');
    const run: Run = {
      id: randomUUID(),
      mode: input.mode,
      trigger: input.job ? 'scheduled' : input.parentRunId ? 'retry' : 'manual',
      state: 'QUEUED',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      policyVersion: policy.version,
      skillId: skill.id,
      skillVersion: skill.version,
      manifestHash: skill.manifestHash,
      date: input.date,
      query: input.query,
      scope: [...(input.scope ?? policy.readPaths)],
      parentRunId: input.parentRunId,
      jobId: job?.id,
      occurrenceKey: input.occurrence?.key,
      scheduledFor: input.occurrence?.scheduledFor,
      stage: '대기',
      modelCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: '가격 미설정',
      evidence: [],
    };
    this.store.state.runs.push(run);
    if (input.occurrence) this.store.state.occurrences.push(structuredClone(input.occurrence));
    try {
      await this.save();
    } catch (error) {
      this.store.state.runs = this.store.state.runs.filter((r) => r.id !== run.id);
      if (input.occurrence)
        this.store.state.occurrences = this.store.state.occurrences.filter(
          (o) => o.key !== input.occurrence!.key,
        );
      throw error;
    }
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    const work = this.queue
      .enqueue(run.id, async () => {
        if (controller.signal.aborted) return;
        await this.execute(run, input.mode, controller, skill, job?.outputPath, job?.timezone);
      })
      .catch(async (error) => {
        if (run.state === 'QUEUED') {
          run.state = 'BLOCKED';
          run.message = this.errorMessage(error);
          await this.save();
        }
      })
      .finally(() => {
        this.controllers.delete(run.id);
        this.pendingWork.delete(work);
      });
    this.pendingWork.add(work);
    return run;
  }
  private errorMessage(error: unknown): string {
    if (error instanceof PolicyError || error instanceof ProviderError)
      return `${error.code}: ${error.message}`;
    // Never expose remote responses or raw provider exception objects.
    if (error instanceof z.ZodError)
      return 'OUTPUT_SCHEMA: 모델 출력 형식이 계약과 다릅니다. 모델의 JSON 출력 설정을 확인하세요.';
    if (
      error instanceof Error &&
      /^(OUTPUT_|CONTEXT_|SKILL_|DATE:|INPUT:|INDEX_)/.test(error.message)
    )
      return error.message;
    return 'RUN_FAILED: 실행을 완료하지 못했습니다. 모델·자료 범위·출력 경로를 확인하세요.';
  }
  private async execute(
    run: Run,
    mode: 'answer' | 'daily' | 'draft',
    controller: AbortController,
    skill: Skill,
    jobOutput?: string,
    timezone = 'Asia/Seoul',
  ): Promise<void> {
    const budget = structuredClone(this.settings().budget),
      guard = new RunGuard(run, budget, controller.signal);
    const deadline = setTimeout(() => controller.abort(), budget.activeTimeoutMs);
    const check = () => {
      guard.check();
      if (this.settings().paused || run.policyVersion !== this.settings().policy.version)
        throw new PolicyError('POLICY_CHANGED', '실행 중 정책이 변경되었습니다. 새로 실행하세요.');
    };
    const stage = async (s: string) => {
      check();
      run.stage = s;
      run.updatedAt = Date.now();
      await this.save();
    };
    try {
      run.state = 'PREPARING';
      await stage('범위와 모델 확인');
      const config = structuredClone(this.settings().generation);
      if (!config.enabled || !config.model)
        throw new ProviderError('CONFIGURATION', '생성 모델을 설정하고 활성화하세요.');
      const provider = createGenerationProvider(config, this.secrets, this.auth);
      if (this.syncGithub && this.settings().githubEnabled) {
        await stage('GitHub 동기화');
        guard.tool();
        await this.syncGithub(controller.signal);
      }
      await this.refreshIndex();
      check();
      run.state = 'RUNNING';
      await stage('근거 검색');
      const githubScope = this.settings().githubEnabled
        ? this.settings().policy.githubRepos.filter(
            (repo) => run.trigger !== 'scheduled' || run.scope.includes(repo),
          )
        : [];
      const registry = new ToolRegistry();
      registry.register({
        name: 'search.query',
        input: z.object({ query: z.string(), paths: z.array(z.string()) }).strict(),
        output: z
          .object({
            evidence: z.array(
              z
                .object({
                  id: z.string(),
                  kind: z.enum(['vault', 'github']),
                  uri: z.string(),
                  path: z.string(),
                  title: z.string(),
                  hash: z.string(),
                  updatedAt: z.number(),
                  indexedAt: z.number(),
                  locator: z.string().optional(),
                  text: z.string(),
                  project: z.string(),
                  tags: z.array(z.string()),
                  score: z.number(),
                  vector: z.array(z.number()).optional(),
                  embeddingKey: z.string().optional(),
                })
                .strict(),
            ),
            mode: z.enum(['hybrid', 'keyword-only']),
            reason: z.string().optional(),
          })
          .strict(),
        authorize: () => check(),
        execute: async (args: { query: string; paths: string[] }) =>
          this.index.search(
            args.query,
            { paths: args.paths, githubRepos: githubScope },
            { signal: controller.signal },
          ),
      });
      // Query embeddings are model calls too and are charged before issuing the query.
      if (
        mode === 'answer' &&
        this.settings().embedding.enabled &&
        this.settings().embeddingDimensions > 0
      ) {
        try {
          assertTransfer(
            this.settings().policy,
            [],
            getDestination(this.settings().embedding),
            true,
          );
          guard.model(estimateTokens(run.query));
        } catch (e) {
          if (e instanceof PolicyError && e.code.includes('BUDGET')) throw e;
        }
      }
      const searchScope = [...run.scope, ...githubScope];
      const found = (await registry.invoke(
        'search.query',
        { query: mode === 'answer' ? run.query : '', paths: searchScope },
        guard,
      )) as SearchResult;
      let evidence: Evidence[];
      if (mode === 'answer') {
        if (found.mode !== 'hybrid')
          throw new ProviderError(
            'CONFIGURATION',
            'RAG 답변에는 생성 모델과 임베딩 모델 및 준비된 벡터가 필요합니다. 검색 탭의 키워드 검색은 계속 사용할 수 있습니다.',
          );
        evidence = this.index.context(found);
      } else {
        // Review scans the chosen recent records, not similarity to a generic instruction.
        const priorDate = new Date(Date.parse(run.date + 'T00:00:00Z') - 6 * 86400000)
          .toISOString()
          .slice(0, 10);
        const nextDate = new Date(Date.parse(run.date + 'T00:00:00Z') + 86400000)
          .toISOString()
          .slice(0, 10);
        const cutoff = zonedOccurrence(priorDate, '00:00', timezone),
          end = zonedOccurrence(nextDate, '00:00', timezone) - 1;
        evidence = this.store.state.index.chunks
          .filter(
            (e) =>
              e.updatedAt >= cutoff &&
              e.updatedAt <= end &&
              (e.kind !== 'github' ||
                githubScope.includes(e.path.split('/').slice(0, 2).join('/'))) &&
              (!searchScope.length ||
                searchScope.some((p) => p === '.' || e.path === p || e.path.startsWith(p + '/'))) &&
              isReadable(this.settings().policy, e),
          )
          .sort((a, b) => b.updatedAt - a.updatedAt);
        const selected: Evidence[] = [];
        const count = new Map<string, number>();
        for (const e of evidence) {
          if ((count.get(e.uri) ?? 0) >= 3) continue;
          if ((await this.resolve(e))?.hash !== e.hash) continue;
          selected.push(e);
          count.set(e.uri, (count.get(e.uri) ?? 0) + 1);
          if (selected.length === 8) break;
        }
        evidence = selected;
      }
      check();
      run.evidence = evidence.map(({ text: _, vector: __, ...e }) => e);
      if (!evidence.length) {
        run.answer =
          '허용된 자료에서 충분한 근거를 찾지 못했습니다. 자료 범위·날짜·색인 상태를 확인하세요.';
        run.state = 'SUCCEEDED';
        run.stage = '근거 부족 · 모델 미호출';
        return;
      }
      const memories = selectMemories(this.store.state.memories, run.scope, (r) =>
        isReadable(this.settings().policy, r),
      );
      for (let i = memories.length - 1; i >= 0; i--) {
        let fresh = true;
        for (const ref of memories[i].sourceRefs)
          if ((await this.resolve(ref))?.hash !== ref.hash) {
            fresh = false;
            break;
          }
        if (!fresh) {
          const entry = this.store.state.memories.find((m) => m.id === memories[i].id);
          if (entry) entry.status = 'inactive';
          memories.splice(i, 1);
        }
      }
      check();
      assertTransfer(
        this.settings().policy,
        [...evidence, ...memories.flatMap((m) => m.sourceRefs)],
        getDestination(config),
        true,
      );
      const schema = mode === 'answer' ? ANSWER_JSON_SCHEMA : REVIEW_JSON_SCHEMA;
      const schemaReserve = estimateTokens(JSON.stringify(schema)) * 2 + 512;
      const context = buildContext({
        query: run.query,
        date: run.date,
        evidence,
        memories,
        skill,
        maxTokens: Math.max(1, budget.maxInputTokens - run.inputTokens - schemaReserve),
        contextWindowTokens: this.settings().generationContextTokens - schemaReserve,
        reserveOutputTokens: budget.maxOutputTokens,
      });
      evidence = evidence.filter((e) => !context.excluded.includes(e.id));
      const boundRefs = [
        ...evidence.map(({ text: _, vector: __, ...e }) => e),
        ...memories.flatMap((m) => m.sourceRefs),
      ];
      run.evidence = [...new Map(boundRefs.map((ref) => [ref.id, ref])).values()];
      if (!evidence.length) throw new Error('CONTEXT_LIMIT: 입력 한도에 들어가는 근거가 없습니다.');
      if (context.excluded.length)
        this.store.state.audit.push({
          at: Date.now(),
          runId: run.id,
          action: 'context.excluded',
          code: String(context.excluded.length),
        });
      await stage('근거 기반 초안 생성');
      const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
        { role: 'system', content: context.system },
        { role: 'user', content: context.user },
      ];
      let result = '';
      let valid = false;
      for (let correction = 0; correction < 2; correction++) {
        let text = '';
        let outputError: unknown;
        for (let attempt = 0; ; attempt++) {
          check();
          assertTransfer(
            this.settings().policy,
            [...evidence, ...memories.flatMap((m) => m.sourceRefs)],
            getDestination(config),
            true,
          );
          for (const e of run.evidence)
            if ((await this.resolve(e))?.hash !== e.hash)
              throw new PolicyError('SOURCE_CHANGED', '근거가 바뀌었습니다. 다시 생성하세요.');
          const inputEstimate = estimateTokens(JSON.stringify(messages)) + schemaReserve + 256;
          if (inputEstimate + budget.maxOutputTokens > this.settings().generationContextTokens)
            throw new Error('CONTEXT_LIMIT: 교정 요청이 모델 컨텍스트 한도를 초과했습니다.');
          guard.model(inputEstimate);
          const requestController = new AbortController();
          const abort = () => requestController.abort();
          let timedOut = false;
          controller.signal.addEventListener('abort', abort, { once: true });
          const timeout = setTimeout(() => {
            timedOut = true;
            abort();
          }, guard.requestTimeoutMs);
          let retryWait = 0;
          try {
            const response = await provider.generate({
              messages,
              jsonSchema: mode === 'answer' ? ANSWER_JSON_SCHEMA : REVIEW_JSON_SCHEMA,
              maxOutputTokens: Math.max(1, budget.maxOutputTokens - run.outputTokens),
              signal: requestController.signal,
            });
            text = response.text;
            guard.output(Math.max(response.usage?.outputTokens ?? 0, estimateTokens(text)));
            break;
          } catch (caught) {
            const error =
              timedOut && !controller.signal.aborted
                ? new ProviderError('TIMEOUT', '모델 요청 제한 시간을 초과했습니다.', true)
                : caught;
            if (error instanceof ProviderError && error.outputTokens !== undefined)
              guard.output(error.outputTokens);
            if (
              error instanceof ProviderError &&
              error.code === 'INVALID_RESPONSE' &&
              correction === 0
            ) {
              outputError = error;
              break;
            }
            if (!(error instanceof ProviderError) || !error.retryable || attempt >= 2) throw error;
            retryWait = Math.max(attempt === 0 ? 2000 : 8000, error.retryAfterMs);
          } finally {
            clearTimeout(timeout);
            controller.signal.removeEventListener('abort', abort);
          }
          await this.delay(retryWait, controller.signal);
        }
        if (!outputError) {
          try {
            result =
              mode === 'answer'
                ? renderAnswer(parseJSON(text), evidence)
                : renderReview(validateReview(parseJSON(text), evidence), evidence, run.date);
            valid = true;
            break;
          } catch (error) {
            outputError = error;
          }
        }
        if (correction === 1) throw outputError;
        messages.push({
          role: 'user',
          content:
            '이전 출력이 JSON 스키마 또는 근거 검증에 실패했습니다. 지정된 스키마와 제공된 id만 사용해 다시 생성하세요. 사실의 sources는 빈 배열일 수 없습니다.',
        });
        await stage('출력 형식과 근거 교정 · 1회');
      }
      if (!valid) throw new Error('OUTPUT_SCHEMA');
      check();
      run.answer = result;
      if (mode === 'answer') {
        run.state = 'SUCCEEDED';
        run.stage = '답변 생성 완료';
      } else {
        await stage('변경안 생성');
        guard.tool();
        const target =
          mode === 'draft'
            ? `${this.settings().draftFolder}/${run.date}-${run.id.slice(0, 8)}.md`
            : dailyTarget(jobOutput ?? this.settings().dailyPath, run.date);
        const change = await this.changes.propose({
          runId: run.id,
          targetPath: target,
          content: result,
          outputKey: `${run.date}:${skill.id}:${hashText(JSON.stringify(run.scope))}`,
          sourceRefs: run.evidence,
          kind: mode === 'draft' ? 'new-draft' : 'daily-section',
        });
        run.changeSetId = change.id;
        run.state = 'WAITING_APPROVAL';
        run.stage = '승인 대기 · 원문 미변경';
      }
    } catch (error) {
      run.state = controller.signal.aborted
        ? 'CANCELED'
        : error instanceof PolicyError || (error instanceof ProviderError && !error.retryable)
          ? 'BLOCKED'
          : 'FAILED';
      run.errorCode =
        error instanceof PolicyError || error instanceof ProviderError ? error.code : 'RUN_FAILED';
      run.message = this.errorMessage(error);
      run.stage = run.state === 'CANCELED' ? '중단됨' : '실행 실패/차단';
    } finally {
      clearTimeout(deadline);
      run.updatedAt = Date.now();
      this.store.state.audit.push({
        at: Date.now(),
        runId: run.id,
        action: 'run.finished',
        code: run.state,
      });
      await this.save();
    }
  }
  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error('CANCELED'));
      const t = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, ms);
      const abort = () => {
        clearTimeout(t);
        reject(new Error('CANCELED'));
      };
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  cancel(id: string): void {
    this.controllers.get(id)?.abort();
    this.queue.cancel(id);
    const r = this.store.state.runs.find((r) => r.id === id);
    if (r && ['QUEUED', 'PREPARING', 'RUNNING'].includes(r.state)) {
      r.state = 'CANCELED';
      r.stage = '중단 요청됨';
      void this.save();
    }
    this.onChange();
  }
  cancelAll(): void {
    for (const id of this.controllers.keys()) this.cancel(id);
    this.embeddingController?.abort();
  }
  async apply(id: string, hash: string): Promise<void> {
    if (this.settings().paused) throw new Error('PAUSED');
    const c = this.store.state.changes.find((c) => c.id === id);
    const run = this.store.state.runs.find((r) => r.id === c?.runId);
    if (run) run.state = 'APPLYING';
    await this.save();
    try {
      await this.changes.approveAndApply(id, hash);
      if (run) {
        run.state = 'SUCCEEDED';
        run.stage = '승인된 변경 적용 완료';
      }
    } catch (e) {
      if (run) {
        run.state = 'BLOCKED';
        run.message = this.errorMessage(e);
      }
      throw e;
    } finally {
      await this.save();
    }
  }
  async tick(): Promise<void> {
    if (this.closing || this.tickBusy || this.settings().paused || this.store.readOnly) return;
    this.tickBusy = true;
    try {
      const now = Date.now();
      for (const change of this.store.state.changes)
        if (change.status === 'pending' && change.expiresAt <= now) {
          change.status = 'expired';
          const run = this.store.state.runs.find((r) => r.id === change.runId);
          if (run) run.state = 'EXPIRED';
        }
      for (const job of this.store.state.jobs) {
        const active = this.store.state.runs
          .filter((r) => ['QUEUED', 'PREPARING', 'RUNNING'].includes(r.state))
          .flatMap((r) => (r.jobId ? [r.jobId] : []));
        const due = collectDueOccurrences(
          job,
          now,
          this.store.state.deviceId,
          this.store.state.occurrences,
          active,
        );
        const previousCheck = job.lastCheckedAt,
          skipped = due.filter((o) => o.state === 'skipped');
        this.store.state.occurrences.push(...skipped);
        job.lastCheckedAt = now;
        try {
          const occurrence = due.find((o) => o.state === 'queued');
          if (occurrence && job.skillId !== this.skill.id) {
            this.store.state.occurrences.push({
              ...occurrence,
              state: 'skipped',
              reason: '예약 Skill이 현재 활성 Skill과 다릅니다. 예약을 다시 검토하세요.',
            });
            await this.save();
          } else if (occurrence)
            await this.enqueue({
              query: '기준 날짜에 확인된 활동과 미완료 업무, 다음 행동을 프로젝트별로 정리해줘.',
              date: occurrence.date,
              mode: 'daily',
              scope: [...job.scope],
              job: structuredClone(job),
              occurrence,
            });
          else await this.save();
        } catch (error) {
          job.lastCheckedAt = previousCheck;
          this.store.state.occurrences = this.store.state.occurrences.filter(
            (o) => !due.some((d) => d.key === o.key),
          );
          throw error;
        }
      }
      await this.save();
    } finally {
      this.tickBusy = false;
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    this.cancelAll();
    await Promise.allSettled([...this.pendingWork, ...(this.indexing ? [this.indexing] : [])]);
    await this.store.close();
  }
}

import { ItemView, Modal, Notice, Setting, type WorkspaceLeaf } from 'obsidian';
import type HarnessPlugin from './main';
import type { ChangeSet, SourceRef, SearchResult } from '../../packages/contracts';
import { today } from './settings';
import { START_MARKER, END_MARKER, isReadable } from '../../packages/core';
export const VIEW_TYPE = 'obsidian-harness-view';
const when = (n: number) => new Date(n).toLocaleString();
export class HarnessView extends ItemView {
  private tab = '도우미';
  private query = '';
  private date = today();
  private result?: SearchResult;
  private filterPath = '';
  private filterProject = '';
  private filterTags = '';
  private filterSource = '';
  private filterFrom = '';
  private filterTo = '';
  constructor(
    leaf: WorkspaceLeaf,
    private plugin: HarnessPlugin,
  ) {
    super(leaf);
  }
  getViewType(): string {
    return VIEW_TYPE;
  }
  getDisplayText(): string {
    return 'Harness';
  }
  getIcon(): string {
    return 'bot';
  }
  async onOpen(): Promise<void> {
    this.render();
  }
  refresh(): void {
    if (
      this.contentEl.contains(document.activeElement) &&
      (document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement)
    )
      return;
    this.render();
  }
  private button(
    parent: HTMLElement,
    label: string,
    action: () => void,
    primary = false,
  ): HTMLButtonElement {
    const b = parent.createEl('button', { text: label, cls: primary ? 'mod-cta' : '' });
    b.type = 'button';
    b.onclick = action;
    return b;
  }
  private action(work: () => Promise<unknown>): () => void {
    return () =>
      this.plugin.action(async () => {
        await work();
        this.render();
      });
  }
  private input(
    parent: HTMLElement,
    label: string,
    value: string,
    onInput: (v: string) => void,
    type = 'text',
  ): HTMLInputElement {
    const wrap = parent.createEl('label', { cls: 'harness-full' });
    wrap.createSpan({ text: label });
    const input = wrap.createEl('input', { type, value });
    input.oninput = () => onInput(input.value);
    return input;
  }
  private visible(refs: SourceRef[]): boolean {
    return refs.every(
      (ref) =>
        isReadable(this.plugin.settings.policy, ref) &&
        (ref.kind !== 'github' ||
          (this.plugin.settings.githubEnabled &&
            !!this.plugin.runtime?.store.state.github.some(
              (s) => s.status !== 'blocked' && s.repo === ref.path.split('/').slice(0, 2).join('/'),
            ))),
    );
  }
  private render(): void {
    const el = this.contentEl;
    el.empty();
    el.addClass('harness-view');
    const head = el.createDiv({ cls: 'harness-header' });
    head.createEl('h3', { text: 'Harness' });
    this.button(head, '중단', () => this.plugin.runtime?.cancelAll());
    const nav = el.createDiv({
      cls: 'harness-tabs',
      attr: { role: 'tablist', 'aria-label': 'Harness 탐색' },
    });
    for (const name of ['도우미', '검색', '실행', '승인함']) {
      const b = this.button(nav, name, () => {
        this.tab = name;
        this.render();
      });
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(this.tab === name));
    }
    const rt = this.plugin.runtime;
    if (!rt) {
      el.createDiv({
        cls: 'harness-warning',
        text: '아직 자료 범위를 선택하지 않았습니다. 설정 → Obsidian Harness에서 운영 저장 위치, 읽기 범위, 모델을 설정하세요. 기본 상태는 읽기·전송·예약이 모두 꺼져 있습니다.',
      });
      return;
    }
    if (rt.store.readOnly)
      el.createDiv({
        cls: 'harness-warning',
        text: rt.store.recoveryMessage ?? '운영 저장소 읽기 전용',
      });
    if (this.plugin.settings.paused)
      el.createDiv({ cls: 'harness-warning', text: '전체 일시정지 중' });
    const index = rt.store.state.index;
    el.createDiv({
      cls: 'harness-muted',
      text: `색인 ${index.documents.length}개 문서 · ${index.chunks.length}개 조각 · 벡터 대기 ${index.pending} · 실패 ${index.failed}\n${this.plugin.settings.embedding.enabled && this.plugin.settings.embeddingDimensions ? '벡터 설정됨 · 검색 시 상태 확인' : '키워드 전용 · 임베딩 미설정'} · ${this.plugin.settings.generation.enabled ? '생성 모델 설정됨' : '생성 비활성'}\n${index.lastSuccessAt ? '최근 색인 ' + when(index.lastSuccessAt) : '색인 이력 없음'}`,
    });
    if (this.tab === '도우미') this.assistant(el);
    else if (this.tab === '검색') this.search(el);
    else if (this.tab === '실행') this.runs(el);
    else this.approvals(el);
  }
  private assistant(el: HTMLElement): void {
    const rt = this.plugin.runtime!;
    el.createDiv({
      cls: 'harness-muted',
      text: `읽기 범위: ${this.plugin.settings.policy.readPaths.join(', ') || '없음'}\nSkill: ${rt.skill.id}@${rt.skill.version}\n업무 정리는 기준 날짜까지 최근 7일 기록에서 최대 8개 근거 조각을 사용합니다. 수정일은 활동일을 의미하지 않습니다.`,
    });
    this.input(el, '기준 날짜', this.date, (v) => (this.date = v), 'date');
    const textarea = el.createEl('textarea', {
      placeholder: '이전 문제의 근거를 찾거나, 오늘 업무 정리를 요청하세요.',
      attr: { 'aria-label': '요청' },
    });
    textarea.value = this.query;
    textarea.oninput = () => (this.query = textarea.value);
    const row = el.createDiv({ cls: 'harness-row' });
    for (const [label, mode] of [
      ['근거 답변', 'answer'],
      ['Daily 변경안', 'daily'],
      ['새 초안 변경안', 'draft'],
    ] as const)
      this.button(
        row,
        label,
        this.action(async () => {
          await rt.enqueue({
            query: this.query || '확인된 업무 활동, 미완료 업무와 다음 행동을 정리해줘.',
            date: this.date,
            mode,
          });
          this.tab = '실행';
        }),
        mode === 'daily',
      );
    el.createDiv({
      cls: 'harness-muted',
      text: '모든 기존 노트 반영은 승인함에서 변경 전후를 검토한 뒤 실행합니다. ChatGPT와 사내 서버 전송은 설정에서 별도 허용한 자료에 한정됩니다.',
    });
    const recent = [...rt.store.state.runs].reverse().find((r) => r.answer);
    if (recent && this.visible(recent.evidence)) {
      el.createEl('h4', { text: `최근 결과 · ${recent.state}` });
      el.createDiv({ cls: 'harness-output', text: recent.answer });
      this.evidence(el, recent.evidence);
    }
  }
  private search(el: HTMLElement): void {
    this.input(el, '검색어', this.query, (v) => (this.query = v));
    const filter = el.createEl('details');
    filter.createEl('summary', { text: '검색 필터' });
    this.input(
      filter,
      '경로 (빈칸: 허용 범위 전체)',
      this.filterPath,
      (v) => (this.filterPath = v),
    );
    this.input(
      filter,
      '프로젝트 (정확히 일치)',
      this.filterProject,
      (v) => (this.filterProject = v),
    );
    this.input(filter, '태그 (쉼표 구분)', this.filterTags, (v) => (this.filterTags = v));
    const source = filter.createEl('select', { attr: { 'aria-label': '자료 출처' } });
    for (const [v, t] of [
      ['', '모든 출처'],
      ['vault', '노트'],
      ['github', 'GitHub'],
    ])
      source.createEl('option', { value: v, text: t });
    source.value = this.filterSource;
    source.onchange = () => (this.filterSource = source.value);
    this.input(filter, '원문 수정일 시작', this.filterFrom, (v) => (this.filterFrom = v), 'date');
    this.input(filter, '원문 수정일 끝', this.filterTo, (v) => (this.filterTo = v), 'date');
    this.button(
      el,
      '검색',
      this.action(async () => {
        this.result = await this.plugin.runtime!.search(this.query, {
          paths: this.filterPath ? [this.filterPath] : undefined,
          project: this.filterProject || undefined,
          tags: this.filterTags ? this.filterTags.split(',').map((v) => v.trim()) : undefined,
          kind: (this.filterSource as 'vault' | 'github') || undefined,
          from: this.filterFrom ? Date.parse(this.filterFrom + 'T00:00:00+09:00') : undefined,
          to: this.filterTo ? Date.parse(this.filterTo + 'T23:59:59+09:00') : undefined,
        });
      }),
      true,
    );
    if (this.result) {
      this.result.evidence = this.result.evidence.filter((e) => this.visible([e]));
      el.createDiv({
        cls: 'harness-muted',
        text: `${this.result.mode === 'hybrid' ? '하이브리드 검색' : '키워드 전용'}${this.result.reason ? ' · ' + this.result.reason : ''}`,
      });
      if (!this.result.evidence.length)
        el.createDiv({ text: '허용된 자료에서 충분한 근거를 찾지 못했습니다.' });
      for (const e of this.result.evidence) {
        const card = el.createDiv({ cls: 'harness-card' });
        this.evidence(card, [e]);
        card.createDiv({ cls: 'harness-output', text: e.text });
      }
    }
  }
  private evidence(el: HTMLElement, refs: SourceRef[]): void {
    for (const [i, e] of refs.entries()) {
      if (!this.visible([e])) continue;
      const row = el.createDiv({ cls: 'harness-row' });
      this.button(
        row,
        `[${i + 1}] ${e.title}`,
        this.action(async () => {
          if (e.kind === 'vault') {
            const line = /L(\d+)$/.exec(e.locator ?? '');
            await this.app.workspace.openLinkText(
              e.path,
              '',
              false,
              line ? { eState: { line: Number(line[1]) - 1 } } : undefined,
            );
          } else {
            const u = new URL(e.uri);
            if (u.protocol === 'https:') window.open(u.href, '_blank', 'noopener');
          }
        }),
      );
      row.createSpan({
        cls: 'harness-muted',
        text: `${e.locator ?? e.path} · 원문 ${when(e.updatedAt)} · 색인/동기화 ${when(e.indexedAt)}`,
      });
    }
  }
  private runs(el: HTMLElement): void {
    const rt = this.plugin.runtime!;
    if (!rt.store.state.runs.length) el.createDiv({ text: '실행 이력이 없습니다.' });
    for (const run of [...rt.store.state.runs].reverse().slice(0, 50)) {
      const card = el.createDiv({ cls: 'harness-card' });
      card.createEl('strong', { text: `${run.state} · ${run.stage}` });
      card.createDiv({
        cls: 'harness-muted',
        text: `${when(run.createdAt)} · ${run.trigger} · ${run.id}\n모델 ${run.modelCalls}/${this.plugin.settings.budget.maxModelCalls} · 도구 ${run.toolCalls} · 입력 ${run.inputTokens} / 출력 ${run.outputTokens} (입력은 보수 추정) · ${run.cost}${run.scheduledFor ? '\n원래 예정 ' + run.scheduledFor : ''}`,
      });
      if (run.message) card.createDiv({ cls: 'harness-warning', text: run.message });
      if (['QUEUED', 'PREPARING', 'RUNNING'].includes(run.state))
        this.button(card, '실행 중단', () => rt.cancel(run.id));
      if (
        ['FAILED', 'BLOCKED', 'CANCELED', 'INTERRUPTED', 'EXPIRED', 'REJECTED'].includes(
          run.state,
        ) &&
        run.query
      )
        this.button(
          card,
          '새 Run으로 재시도',
          this.action(() =>
            rt.enqueue({
              query: run.query,
              date: run.date,
              mode: run.mode ?? 'daily',
              scope: run.scope,
              parentRunId: run.id,
            }),
          ),
        );
      if (run.changeSetId)
        this.button(card, '승인함 보기', () => {
          this.tab = '승인함';
          this.render();
        });
      if (run.answer && this.visible(run.evidence)) {
        const details = card.createEl('details');
        details.createEl('summary', { text: '결과와 근거' });
        details.createDiv({ cls: 'harness-output', text: run.answer });
        this.evidence(details, run.evidence);
      }
    }
    if (rt.store.state.occurrences.length) {
      const details = el.createEl('details');
      details.createEl('summary', { text: '예약 발생 이력' });
      for (const o of [...rt.store.state.occurrences].reverse().slice(0, 20))
        details.createDiv({
          cls: 'harness-muted',
          text: `${o.scheduledFor} · ${o.state} · ${o.reason ?? o.key}`,
        });
    }
  }
  private approvals(el: HTMLElement): void {
    const rt = this.plugin.runtime!;
    if (!rt.store.state.changes.length) el.createDiv({ text: '승인할 변경안이 없습니다.' });
    for (const c of [...rt.store.state.changes].reverse().slice(0, 30)) {
      const card = el.createDiv({ cls: 'harness-card' });
      card.createEl('strong', { text: `${c.status} · ${c.targetUri}` });
      card.createDiv({
        cls: 'harness-muted',
        text: `정책 v${c.policyVersion} · 만료 ${when(c.expiresAt)} · ${c.kind}\n변경 해시 ${c.patchHash.slice(0, 16)}`,
      });
      if (!this.visible(c.sourceRefs)) {
        card.createDiv({
          cls: 'harness-warning',
          text: '근거 접근이 철회되어 이 변경안의 내용을 숨겼습니다. 범위를 검토한 뒤 새로 생성하세요.',
        });
        continue;
      }
      this.evidence(card, c.sourceRefs);
      for (const [label, text] of [
        ['변경 전', c.before ?? '(파일 없음)'],
        ['변경 후', c.after],
      ]) {
        const details = card.createEl('details');
        details.createEl('summary', { text: label });
        details.createEl('pre', { cls: 'harness-diff', text });
      }
      const row = card.createDiv({ cls: 'harness-row' });
      if (c.status === 'pending') {
        this.button(
          row,
          '변경 검토 후 적용',
          () => new ConfirmApplyModal(this.plugin, c, () => this.render()).open(),
          true,
        );
        this.button(
          row,
          '거절',
          this.action(async () => {
            await rt.changes.reject(c.id);
            const r = rt.store.state.runs.find((r) => r.id === c.runId);
            if (r) r.state = 'REJECTED';
            await rt.save();
          }),
        );
        if (c.kind !== 'rollback')
          this.button(row, '초안 수정', () =>
            new EditChangeModal(this.plugin, c, () => this.render()).open(),
          );
      }
      if (c.status === 'applied' && c.before !== null)
        this.button(
          row,
          '역변경 제안',
          this.action(() => rt.changes.proposeRollback(c.id)),
        );
    }
  }
}
class ConfirmApplyModal extends Modal {
  constructor(
    private plugin: HarnessPlugin,
    private c: ChangeSet,
    private done: () => void,
  ) {
    super(plugin.app);
  }
  onOpen(): void {
    this.contentEl.createEl('h3', { text: '단일 파일 변경 승인' });
    this.contentEl.createDiv({
      text: `대상: ${this.c.targetUri}\n이 노트를 저장하고 모든 편집 창에서 닫아 주세요. 원문과 근거 버전이 달라지면 적용을 차단합니다.`,
      cls: 'harness-output',
    });
    this.contentEl.createEl('pre', { cls: 'harness-diff', text: this.c.after });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText('돌아가기').onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText('이 변경 적용')
          .setCta()
          .onClick(() => {
            b.setDisabled(true);
            this.plugin.action(async () => {
              try {
                await this.plugin.requireRuntime().apply(this.c.id, this.c.patchHash);
                new Notice('승인한 변경을 적용했습니다.');
                this.close();
                this.done();
              } finally {
                b.setDisabled(false);
              }
            });
          }),
      );
  }
}
class EditChangeModal extends Modal {
  constructor(
    private plugin: HarnessPlugin,
    private c: ChangeSet,
    private done: () => void,
  ) {
    super(plugin.app);
  }
  onOpen(): void {
    this.contentEl.createEl('h3', { text: '초안 수정 · 새 승인 필요' });
    const textarea = this.contentEl.createEl('textarea', { cls: 'harness-full' });
    textarea.style.minHeight = '320px';
    textarea.value =
      this.c.kind === 'daily-section'
        ? (this.c.after.split(START_MARKER)[1]?.split(END_MARKER)[0]?.trim() ?? '')
        : this.c.after;
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText('새 변경안 생성')
        .setCta()
        .onClick(() =>
          this.plugin.action(async () => {
            const next = await this.plugin.requireRuntime().changes.edit(this.c.id, textarea.value);
            const r = this.plugin
              .requireRuntime()
              .store.state.runs.find((r) => r.id === this.c.runId);
            if (r) {
              r.changeSetId = next.id;
              r.state = 'WAITING_APPROVAL';
            }
            await this.plugin.requireRuntime().save();
            this.close();
            this.done();
          }),
        ),
    );
  }
}

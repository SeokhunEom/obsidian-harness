import { randomUUID } from 'node:crypto';
import type { ChangeSet, Policy, SourceRef, StateStore, VaultPort } from '../contracts';
import { assertRead, assertWrite, PolicyError } from './policy';
import { hashText, MISSING_HASH } from './hash';
export const START_MARKER = '<!-- harness:daily-work-review:start -->';
export const END_MARKER = '<!-- harness:daily-work-review:end -->';
function bodySafe(body: string): void {
  if (/<!--\s*harness\s*:/i.test(body))
    throw new PolicyError(
      'MARKER_INJECTION',
      '생성 내용에는 Harness 관리 구역 표시를 넣을 수 없습니다.',
    );
}
export function upsertDailySection(before: string | null, body: string): string {
  bodySafe(body);
  const original = before ?? '';
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const content = body.replace(/\r\n|\r|\n/g, eol).replace(/[\r\n]+$/, '');
  const starts = [...original.matchAll(/<!--\s*harness:daily-work-review:start\s*-->/g)];
  const ends = [...original.matchAll(/<!--\s*harness:daily-work-review:end\s*-->/g)];
  const markerLike = original.match(/<!--\s*harness\s*:/gi) ?? [];
  if (
    starts.length !== ends.length ||
    starts.length > 1 ||
    markerLike.length !== starts.length + ends.length
  )
    throw new PolicyError(
      'MALFORMED_MARKERS',
      '관리 구역 표시가 중복되거나 불완전합니다. 원문에서 직접 확인해 주세요.',
    );
  const section = `${START_MARKER}${eol}${content}${eol}${END_MARKER}`;
  if (!starts.length)
    return `${original}${original && !original.endsWith('\n') ? eol : ''}${original ? eol : ''}${section}${eol}`;
  const start = starts[0].index!;
  const end = ends[0].index!;
  if (
    start >= end ||
    starts[0][0] !== START_MARKER ||
    ends[0][0] !== END_MARKER ||
    (start > 0 && original[start - 1] !== '\n') ||
    (end > 0 && original[end - 1] !== '\n') ||
    !['\r', '\n', undefined].includes(original[start + START_MARKER.length]) ||
    !['\r', '\n', undefined].includes(original[end + END_MARKER.length])
  )
    throw new PolicyError(
      'MALFORMED_MARKERS',
      '관리 구역 표시는 각각 독립된 줄에 정확하게 있어야 합니다.',
    );
  return original.slice(0, start) + section + original.slice(end + END_MARKER.length);
}
function patchHash(c: ChangeSet): string {
  return hashText(
    JSON.stringify({
      id: c.id,
      runId: c.runId,
      targetUri: c.targetUri,
      baseHash: c.baseHash,
      expectedHash: c.expectedHash,
      outputKey: c.outputKey,
      sourceRefs: c.sourceRefs,
      policyVersion: c.policyVersion,
      before: c.before,
      after: c.after,
      createdAt: c.createdAt,
      expiresAt: c.expiresAt,
      kind: c.kind,
      rollbackOf: c.rollbackOf,
    }),
  );
}
export interface ChangeProposal {
  runId: string;
  targetPath: string;
  content: string;
  outputKey: string;
  sourceRefs: SourceRef[];
  kind?: 'daily-section' | 'new-draft';
  ttlMs?: number;
}
export type SourceResolver = (ref: SourceRef) => Promise<SourceRef | null>;
export class ChangeManager {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private store: StateStore,
    private vault: VaultPort,
    private getPolicy: () => Policy,
    private resolveSource: SourceResolver,
  ) {}
  private writable(): void {
    if (this.store.readOnly)
      throw new PolicyError(
        'STATE_READ_ONLY',
        '운영 저장소가 읽기 전용입니다. 복구 후 다시 시도하세요.',
      );
  }
  private find(id: string): ChangeSet {
    const c = this.store.state.changes.find((c) => c.id === id);
    if (!c) throw new PolicyError('CHANGE_MISSING', '변경안을 찾을 수 없습니다.');
    return c;
  }
  async propose(input: ChangeProposal): Promise<ChangeSet> {
    this.writable();
    const policy = this.getPolicy();
    assertWrite(policy, input.targetPath);
    for (const ref of input.sourceRefs) assertRead(policy, ref);
    const before = await this.vault.read(input.targetPath);
    if (input.kind === 'new-draft' && before !== null)
      throw new PolicyError(
        'TARGET_EXISTS',
        '기존 파일을 덮어쓸 수 없습니다. 다른 새 초안 경로를 선택하세요.',
      );
    const after =
      input.kind === 'new-draft'
        ? (bodySafe(input.content), input.content)
        : upsertDailySection(before, input.content);
    const c: ChangeSet = {
      id: randomUUID(),
      runId: input.runId,
      targetUri: input.targetPath,
      baseHash: hashText(before),
      expectedHash: hashText(after),
      patchHash: '',
      outputKey: input.outputKey,
      sourceRefs: structuredClone(input.sourceRefs),
      policyVersion: policy.version,
      before,
      after,
      createdAt: Date.now(),
      expiresAt: Date.now() + (input.ttlMs ?? 86_400_000),
      status: 'pending',
      kind: input.kind ?? 'daily-section',
    };
    c.patchHash = patchHash(c);
    this.store.state.changes.push(c);
    await this.store.save();
    return c;
  }
  async edit(id: string, content: string): Promise<ChangeSet> {
    const c = this.find(id);
    if (c.status !== 'pending')
      throw new PolicyError('CHANGE_STATE', '승인 대기 변경안만 수정할 수 있습니다.');
    if (c.kind === 'rollback')
      throw new PolicyError('CHANGE_STATE', '역변경 내용은 수정할 수 없습니다.');
    const next = await this.propose({
      runId: c.runId,
      targetPath: c.targetUri,
      content,
      outputKey: c.outputKey,
      sourceRefs: c.sourceRefs,
      kind: c.kind,
    });
    c.status = 'rejected';
    c.approvedHash = undefined;
    await this.store.save();
    return next;
  }
  async reject(id: string): Promise<void> {
    this.writable();
    const c = this.find(id);
    if (c.status === 'pending') {
      c.status = 'rejected';
      c.approvedHash = undefined;
      await this.store.save();
    }
  }
  approveAndApply(id: string, approvedPatchHash: string): Promise<ChangeSet> {
    const task = this.tail.then(() => this.apply(id, approvedPatchHash));
    this.tail = task.catch(() => undefined);
    return task;
  }
  private async apply(id: string, approvedPatchHash: string): Promise<ChangeSet> {
    this.writable();
    const c = this.find(id);
    if (c.status === 'applied') return c;
    if (c.status !== 'pending')
      throw new PolicyError('CHANGE_STATE', '이 변경안은 승인할 수 없습니다.');
    if (Date.now() >= c.expiresAt) {
      c.status = 'expired';
      await this.store.save();
      throw new PolicyError(
        'APPROVAL_EXPIRED',
        '승인 유효기간이 끝났습니다. 새 변경안을 만드세요.',
      );
    }
    const policy = this.getPolicy();
    if (
      policy.version !== c.policyVersion ||
      approvedPatchHash !== c.patchHash ||
      patchHash(c) !== c.patchHash
    )
      throw new PolicyError(
        'APPROVAL_STALE',
        '내용 또는 정책이 바뀌었습니다. 새 변경안을 검토하세요.',
      );
    assertWrite(policy, c.targetUri);
    for (const ref of c.sourceRefs) {
      assertRead(policy, ref);
      const current = await this.resolveSource(ref);
      if (
        !current ||
        current.hash !== ref.hash ||
        current.kind !== ref.kind ||
        current.path !== ref.path ||
        current.id !== ref.id ||
        current.uri !== ref.uri
      )
        throw new PolicyError(
          'SOURCE_CHANGED',
          '근거가 변경되거나 삭제되었습니다. 다시 생성해 주세요.',
        );
    }
    if (this.vault.isOpen(c.targetUri))
      throw new PolicyError(
        'EDITOR_OPEN',
        '대상 노트를 저장하고 모든 편집 창에서 닫은 뒤 다시 승인하세요.',
      );
    const current = await this.vault.read(c.targetUri);
    if (hashText(current) !== c.baseHash)
      throw new PolicyError('TARGET_CHANGED', '대상 원문이 바뀌었습니다. 새 변경안을 만드세요.');
    // Bind policy again after asynchronous source/target reads and before the durable intent.
    if (this.getPolicy().version !== c.policyVersion)
      throw new PolicyError('APPROVAL_STALE', '검사 중 권한이 바뀌었습니다.');
    c.approvedHash = approvedPatchHash;
    const intent = {
      changeSetId: c.id,
      targetUri: c.targetUri,
      baseHash: c.baseHash,
      expectedHash: c.expectedHash,
      state: 'prepared' as const,
      createdAt: Date.now(),
    };
    this.store.state.intents.push(intent);
    await this.store.save();
    try {
      if (this.getPolicy().version !== c.policyVersion)
        throw new PolicyError('APPROVAL_STALE', '적용 전 권한이 바뀌었습니다.');
      assertWrite(this.getPolicy(), c.targetUri);
      await this.vault.apply(c.targetUri, c.baseHash, c.after);
      if (hashText(await this.vault.read(c.targetUri)) !== c.expectedHash)
        throw new PolicyError('APPLY_UNCERTAIN', '적용 결과가 예상과 다릅니다. 원문을 확인하세요.');
      c.status = 'applied';
      c.appliedAt = Date.now();
      const stored = [...this.store.state.intents].reverse().find((i) => i.changeSetId === c.id)!;
      stored.state = 'applied';
      this.store.state.audit.push({
        at: Date.now(),
        runId: c.runId,
        action: 'change.applied',
        ref: c.id,
      });
      await this.store.save();
      return c;
    } catch (error) {
      // Keep a prepared intent if the result is unknown. Recovery compares hashes without replaying writes.
      throw error;
    }
  }
  async recover(): Promise<void> {
    if (this.store.readOnly) return;
    for (const intent of this.store.state.intents.filter((i) => i.state === 'prepared')) {
      const c = this.store.state.changes.find((c) => c.id === intent.changeSetId);
      if (!c) {
        intent.state = 'blocked';
        continue;
      }
      try {
        const current = hashText(await this.vault.read(intent.targetUri));
        if (current === intent.expectedHash) {
          intent.state = 'applied';
          c.status = 'applied';
          c.appliedAt ??= Date.now();
        } else if (current === intent.baseHash) {
          intent.state = 'blocked';
          c.status = 'pending';
          c.approvedHash = undefined;
        } else {
          intent.state = 'blocked';
          c.status = 'blocked';
          c.approvedHash = undefined;
        }
      } catch {
        intent.state = 'blocked';
        c.status = 'blocked';
      }
    }
    for (const run of this.store.state.runs)
      if (['PREPARING', 'RUNNING', 'APPLYING', 'QUEUED'].includes(run.state)) {
        const applied = this.store.state.changes.find(
          (c) => c.runId === run.id && c.status === 'applied',
        );
        run.state = applied ? 'SUCCEEDED' : 'INTERRUPTED';
        run.errorCode = applied ? undefined : 'RESTART_INTERRUPTED';
        run.updatedAt = Date.now();
      }
    await this.store.save();
  }
  async proposeRollback(id: string): Promise<ChangeSet> {
    this.writable();
    const original = this.find(id);
    const policy = this.getPolicy();
    assertWrite(policy, original.targetUri);
    if (
      original.status !== 'applied' ||
      original.before === null ||
      original.baseHash === MISSING_HASH
    )
      throw new PolicyError(
        'ROLLBACK_UNAVAILABLE',
        '새 파일 삭제는 지원하지 않습니다. 기존 파일에 적용한 변경만 되돌릴 수 있습니다.',
      );
    const before = await this.vault.read(original.targetUri);
    if (hashText(before) !== original.expectedHash)
      throw new PolicyError('TARGET_CHANGED', '적용 후 원문이 변경되어 역변경을 만들 수 없습니다.');
    const c: ChangeSet = {
      ...original,
      id: randomUUID(),
      before,
      after: original.before,
      baseHash: original.expectedHash,
      expectedHash: original.baseHash,
      patchHash: '',
      policyVersion: policy.version,
      createdAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
      status: 'pending',
      kind: 'rollback',
      rollbackOf: original.id,
      approvedHash: undefined,
      appliedAt: undefined,
    };
    c.patchHash = patchHash(c);
    this.store.state.changes.push(c);
    await this.store.save();
    return c;
  }
}

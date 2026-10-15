import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { HarnessState, StateStore } from '../contracts';
import { hashText, PolicyError } from '../core';

export function emptyState(deviceId = randomUUID()): HarnessState {
  return {
    schemaVersion: 1,
    deviceId,
    runs: [],
    changes: [],
    intents: [],
    memories: [],
    jobs: [],
    occurrences: [],
    index: { documents: [], chunks: [], processed: 0, pending: 0, failed: 0, paused: false },
    github: [],
    audit: [],
  };
}
const ref = z.object({
  id: z.string(),
  kind: z.enum(['vault', 'github']),
  uri: z.string(),
  path: z.string(),
  title: z.string(),
  hash: z.string(),
  updatedAt: z.number(),
  indexedAt: z.number(),
  locator: z.string().optional(),
});
const document = ref.extend({ text: z.string(), project: z.string(), tags: z.array(z.string()) });
const evidence = document.extend({
  score: z.number(),
  vector: z.array(z.number()).optional(),
  embeddingKey: z.string().optional(),
});
const change = z.object({
  id: z.string(),
  runId: z.string(),
  targetUri: z.string(),
  baseHash: z.string(),
  patchHash: z.string(),
  expectedHash: z.string(),
  outputKey: z.string(),
  sourceRefs: z.array(ref),
  policyVersion: z.number().int(),
  before: z.string().nullable(),
  after: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
  status: z.enum(['pending', 'applied', 'rejected', 'expired', 'blocked']),
  kind: z.enum(['daily-section', 'new-draft', 'rollback']),
  approvedHash: z.string().optional(),
  appliedAt: z.number().optional(),
  rollbackOf: z.string().optional(),
});
const run = z.object({
  id: z.string(),
  mode: z.enum(['answer', 'daily', 'draft']).optional(),
  trigger: z.enum(['manual', 'scheduled', 'retry']),
  state: z.enum([
    'QUEUED',
    'PREPARING',
    'RUNNING',
    'WAITING_APPROVAL',
    'APPLYING',
    'SUCCEEDED',
    'FAILED',
    'BLOCKED',
    'REJECTED',
    'EXPIRED',
    'CANCELED',
    'INTERRUPTED',
  ]),
  createdAt: z.number(),
  updatedAt: z.number(),
  policyVersion: z.number(),
  skillId: z.string(),
  skillVersion: z.string(),
  manifestHash: z.string(),
  date: z.string(),
  query: z.string(),
  scope: z.array(z.string()),
  stage: z.string(),
  modelCalls: z.number(),
  toolCalls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cost: z.literal('가격 미설정'),
  evidence: z.array(ref),
  parentRunId: z.string().optional(),
  jobId: z.string().optional(),
  occurrenceKey: z.string().optional(),
  scheduledFor: z.string().optional(),
  errorCode: z.string().optional(),
  message: z.string().optional(),
  answer: z.string().optional(),
  changeSetId: z.string().optional(),
});
const schema = z.object({
  schemaVersion: z.literal(1),
  deviceId: z.string().min(1),
  runs: z.array(run),
  changes: z.array(change),
  intents: z.array(
    z.object({
      changeSetId: z.string(),
      targetUri: z.string(),
      baseHash: z.string(),
      expectedHash: z.string(),
      state: z.enum(['prepared', 'applied', 'blocked']),
      createdAt: z.number(),
    }),
  ),
  memories: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      status: z.enum(['candidate', 'confirmed', 'inactive', 'expired']),
      scope: z.array(z.string()),
      sourceRefs: z.array(ref),
      reviewedAt: z.number(),
      expiresAt: z.number().optional(),
    }),
  ),
  jobs: z.array(
    z.object({
      id: z.string(),
      version: z.number(),
      enabled: z.boolean(),
      frequency: z.enum(['daily', 'weekdays']),
      localTime: z.string(),
      timezone: z.string(),
      deviceId: z.string(),
      scope: z.array(z.string()),
      outputPath: z.string(),
      skillId: z.string(),
      createdAt: z.number(),
      lastCheckedAt: z.number(),
      missedRunPolicy: z.literal('latest_once_within_24h'),
    }),
  ),
  occurrences: z.array(
    z.object({
      key: z.string(),
      jobId: z.string(),
      scheduledFor: z.string(),
      date: z.string(),
      state: z.enum(['queued', 'skipped']),
      reason: z.string().optional(),
    }),
  ),
  index: z.object({
    documents: z.array(document),
    chunks: z.array(evidence),
    embeddingKey: z.string().optional(),
    processed: z.number(),
    pending: z.number(),
    failed: z.number(),
    lastSuccessAt: z.number().optional(),
    paused: z.boolean(),
  }),
  github: z.array(
    z.object({
      repo: z.string(),
      cursor: z.string().optional(),
      lastSuccessAt: z.number().optional(),
      status: z.enum(['idle', 'syncing', 'success', 'partial', 'blocked', 'failed']),
      message: z.string().optional(),
      documents: z.array(document),
    }),
  ),
  audit: z.array(
    z.object({
      at: z.number(),
      runId: z.string().optional(),
      action: z.string(),
      code: z.string().optional(),
      ref: z.string().optional(),
    }),
  ),
});
/** Local OS application data, scoped to the canonical Vault path; never the synced plugin folder. */
export function localStateDirectory(vaultPath: string): string {
  const root =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  const canonical = realpathSync(vaultPath);
  const directory = path.join(root, 'ObsidianHarness', hashText(canonical).slice(0, 24));
  const relative = path.relative(canonical, directory);
  if (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
    throw new PolicyError(
      'STATE_INSIDE_VAULT',
      '운영 저장소가 Vault 안에 배치됩니다. 별도의 업무 Vault 위치를 사용하세요.',
    );
  return directory;
}
export interface RetentionOptions {
  logDays?: number;
  artifactDays?: number;
  snapshotDays?: number;
}
export function cleanupRetention(
  state: HarnessState,
  now = Date.now(),
  options: RetentionOptions = {},
): void {
  const valid = (value: number | undefined, fallback: number) =>
    Number.isFinite(value) && value! >= 1 ? value! : fallback;
  const logDays = valid(options.logDays, 90);
  const artifactDays = valid(options.artifactDays, 7);
  const snapshotDays = valid(options.snapshotDays, 7);
  const day = 86_400_000;
  const active = new Set(['QUEUED', 'PREPARING', 'RUNNING', 'WAITING_APPROVAL', 'APPLYING']);
  state.runs = state.runs.filter((r) => active.has(r.state) || now - r.updatedAt < logDays * day);
  for (const run of state.runs)
    if (now - run.updatedAt > artifactDays * day) {
      run.query = '';
      run.answer = undefined;
      run.message = undefined;
    }
  for (const c of state.changes)
    if (c.status === 'pending' && c.expiresAt <= now) {
      c.status = 'expired';
      c.approvedHash = undefined;
    }
  const prepared = new Set(
    state.intents.filter((i) => i.state === 'prepared').map((i) => i.changeSetId),
  );
  state.changes = state.changes.filter(
    (c) =>
      prepared.has(c.id) ||
      c.status === 'pending' ||
      now - (c.appliedAt ?? c.createdAt) <
        (c.status === 'applied' ? snapshotDays : artifactDays) * day,
  );
  state.intents = state.intents.filter(
    (i) => i.state === 'prepared' || now - i.createdAt < logDays * day,
  );
  state.audit = state.audit.filter((a) => now - a.at < logDays * day);
  state.occurrences = state.occurrences.filter(
    (o) => now - Date.parse(o.scheduledFor) < logDays * day,
  );
}
export interface StoreOptions {
  directory: string;
  vaultId?: string;
}
export class JsonStateStore implements StateStore {
  state: HarnessState = emptyState();
  readOnly = false;
  recoveryMessage?: string;
  readonly directory: string;
  private token = randomUUID();
  private ownsLock = false;
  private closed = false;
  private closing = false;
  private tail: Promise<void> = Promise.resolve();
  private constructor(options: StoreOptions) {
    this.directory = options.directory;
  }
  static async open(options: StoreOptions): Promise<JsonStateStore> {
    const store = new JsonStateStore(options);
    await store.initialize();
    return store;
  }
  private get file(): string {
    return path.join(this.directory, 'state.json');
  }
  private get lockFile(): string {
    return path.join(this.directory, 'state.lock');
  }
  private async initialize(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      let handle;
      try {
        handle = await fs.open(this.lockFile, 'wx', 0o600);
      } catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
        const lock = JSON.parse(await fs.readFile(this.lockFile, 'utf8'));
        if (!Number.isInteger(lock.pid) || lock.pid < 1 || typeof lock.token !== 'string')
          throw new Error('INVALID_LOCK');
        try {
          process.kill(lock.pid, 0);
          throw new Error('STATE_LOCKED');
        } catch (probe: any) {
          if (probe.code !== 'ESRCH') throw probe;
        }
        // A dead process cannot mutate its lock. Keep the stale record for diagnosis.
        await fs.rename(
          this.lockFile,
          path.join(this.directory, `state.lock.stale-${Date.now()}-${this.token}`),
        );
        handle = await fs.open(this.lockFile, 'wx', 0o600);
      }
      await handle.writeFile(JSON.stringify({ pid: process.pid, token: this.token }));
      await handle.sync();
      await handle.close();
      this.ownsLock = true;
    } catch {
      this.readOnly = true;
      this.recoveryMessage =
        '저장소 잠금이 있습니다. 다른 Obsidian 인스턴스가 닫혔는지 확인하세요.';
    }
    let primary: string | null = null;
    try {
      primary = await fs.readFile(this.file, 'utf8');
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        this.readOnly = true;
        this.recoveryMessage = '운영 상태를 읽을 수 없습니다.';
      }
    }
    if (primary !== null) {
      try {
        this.state = schema.parse(JSON.parse(primary));
      } catch {
        this.readOnly = true;
        this.recoveryMessage =
          '운영 상태가 손상되었습니다. 원본과 백업을 보존하고 읽기 전용으로 시작했습니다.';
        try {
          this.state = schema.parse(JSON.parse(await fs.readFile(`${this.file}.bak`, 'utf8')));
        } catch {
          /* Preserve files; empty read-only state. */
        }
      }
    } else if (!this.readOnly) {
      try {
        await fs.access(`${this.file}.bak`);
        this.readOnly = true;
        this.recoveryMessage = '주 상태 파일이 없어 백업 복구 확인이 필요합니다.';
        this.state = schema.parse(JSON.parse(await fs.readFile(`${this.file}.bak`, 'utf8')));
      } catch (error: any) {
        if (error.code !== 'ENOENT') {
          this.readOnly = true;
          this.recoveryMessage = '주 상태 파일과 백업을 확인하세요.';
        }
      }
      if (!this.readOnly) await this.save();
    }
  }
  save(): Promise<void> {
    if (this.readOnly || this.closed || this.closing)
      return Promise.reject(new PolicyError('STATE_READ_ONLY', '운영 저장소는 읽기 전용입니다.'));
    // Capture now; later mutations must not leak into an earlier queued snapshot.
    const snapshot = JSON.stringify(schema.parse(structuredClone(this.state)));
    const task = this.tail.then(async () => {
      if (this.readOnly || this.closed)
        throw new PolicyError('STATE_READ_ONLY', '운영 저장소는 읽기 전용입니다.');
      const temp = path.join(this.directory, `state.${randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temp, 'wx', 0o600);
        try {
          await handle.writeFile(snapshot);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          const previous = await fs.readFile(this.file, 'utf8');
          schema.parse(JSON.parse(previous));
          const backupTemp = `${temp}.bak`;
          const backup = await fs.open(backupTemp, 'wx', 0o600);
          try {
            await backup.writeFile(previous);
            await backup.sync();
          } finally {
            await backup.close();
          }
          await fs.rename(backupTemp, `${this.file}.bak`);
        } catch (error: any) {
          if (error.code !== 'ENOENT') throw error;
        }
        await fs.rename(temp, this.file);
        try {
          const dir = await fs.open(this.directory, 'r');
          try {
            await dir.sync();
          } finally {
            await dir.close();
          }
        } catch (error: any) {
          if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
        }
      } catch (error) {
        this.readOnly = true;
        this.recoveryMessage =
          '상태 저장에 실패하여 쓰기를 중단했습니다. 원본과 임시 파일을 보존했습니다.';
        throw error;
      }
    });
    this.tail = task.catch(() => undefined);
    return task;
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.tail;
    this.closed = true;
    if (this.ownsLock) {
      try {
        const lock = JSON.parse(await fs.readFile(this.lockFile, 'utf8'));
        if (lock.token === this.token) await fs.unlink(this.lockFile);
      } catch {
        /* Never delete another writer's lock. */
      }
      this.ownsLock = false;
    }
  }
}

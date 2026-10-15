import type { Job, Occurrence } from '../contracts';

const DAY = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let value = formatters.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timezone, value);
  }
  return value;
}
function localParts(at: number, timezone: string): { date: string; time: string; wall: number } {
  const parts = Object.fromEntries(
    formatter(timezone)
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    wall: Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
    ),
  };
}
export function localDate(at: number, timezone = 'Asia/Seoul'): string {
  return localParts(at, timezone).date;
}
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}
export function validateJob(job: Job): void {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(job.localTime))
    throw new Error('예약 시각은 HH:mm 형식이어야 합니다.');
  formatter(job.timezone || 'Asia/Seoul');
  if (!['daily', 'weekdays'].includes(job.frequency))
    throw new Error('지원하지 않는 예약 반복입니다.');
  if (job.missedRunPolicy !== 'latest_once_within_24h')
    throw new Error('지원하지 않는 보충 정책입니다.');
  if (
    !Number.isInteger(job.version) ||
    job.version < 1 ||
    !job.id ||
    !job.deviceId ||
    !Number.isFinite(job.createdAt)
  )
    throw new Error('예약 식별자·버전·실행 기기를 확인하세요.');
}
/** Ambiguous fall-back times use the first occurrence. Gaps move to the next valid local minute. */
export function zonedOccurrence(date: string, time: string, timezone = 'Asia/Seoul'): number {
  const desired = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(desired)) throw new Error('INVALID_LOCAL_DATE');
  const offsets = new Set<number>();
  for (let offset = -36; offset <= 36; offset += 6) {
    const sample = desired + offset * 3_600_000;
    offsets.add(localParts(sample, timezone).wall - sample);
  }
  const exact = [...offsets]
    .map((offset) => desired - offset)
    .filter((utc) => localParts(utc, timezone).wall === desired);
  if (exact.length) return Math.min(...exact);
  // A DST gap is bounded to a local date. Entirely skipped dates are omitted by the caller.
  let chosen = Infinity,
    earliestLocal = Infinity;
  for (const offset of offsets) {
    const projected = desired - offset;
    for (let minute = -180; minute <= 180; minute++) {
      const candidate = projected + minute * 60_000,
        local = localParts(candidate, timezone);
      if (local.date !== date || local.wall < desired) continue;
      if (local.wall < earliestLocal || (local.wall === earliestLocal && candidate < chosen)) {
        earliestLocal = local.wall;
        chosen = candidate;
      }
    }
  }
  return chosen;
}
function runsOnDate(job: Job, date: string): boolean {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return job.frequency === 'daily' || (weekday !== 0 && weekday !== 6);
}
function occurrence(job: Job, date: string): Occurrence | undefined {
  const utc = zonedOccurrence(date, job.localTime, job.timezone || 'Asia/Seoul');
  if (!Number.isFinite(utc)) return undefined;
  const scheduledFor = new Date(utc).toISOString();
  return {
    key: `${job.id}|${scheduledFor}|v${job.version}`,
    jobId: job.id,
    date,
    scheduledFor,
    state: 'queued',
  };
}
export function nextOccurrence(job: Job, after: number): Occurrence {
  validateJob(job);
  const date = localDate(after, job.timezone || 'Asia/Seoul');
  for (let day = 0; day < 14; day++) {
    const candidateDate = addDays(date, day);
    if (!runsOnDate(job, candidateDate)) continue;
    const candidate = occurrence(job, candidateDate);
    if (candidate && Date.parse(candidate.scheduledFor) > after) return candidate;
  }
  throw new Error('다음 실행 시각을 계산할 수 없습니다.');
}
/** Pure calculation. Persist returned keys together with Run creation before advancing lastCheckedAt. */
export function collectDueOccurrences(
  job: Job,
  now: number,
  deviceId: string,
  existing: readonly Occurrence[],
  activeJobIds: readonly string[] = [],
): Occurrence[] {
  validateJob(job);
  if (!job.enabled || job.deviceId !== deviceId || now < job.createdAt) return [];
  const from = Math.max(job.createdAt, job.lastCheckedAt || job.createdAt),
    seen = new Set(existing.map((item) => item.key));
  let date = localDate(from, job.timezone || 'Asia/Seoul');
  const today = localDate(now, job.timezone || 'Asia/Seoul'),
    due: Occurrence[] = [];
  for (; date <= today; date = addDays(date, 1)) {
    if (!runsOnDate(job, date)) continue;
    const item = occurrence(job, date);
    if (!item) continue;
    const scheduled = Date.parse(item.scheduledFor);
    if (scheduled >= from && scheduled <= now && !seen.has(item.key)) due.push(item);
  }
  const latest = due.at(-1);
  return due.map((item) => {
    const tooOld = now - Date.parse(item.scheduledFor) > DAY;
    const active = activeJobIds.includes(job.id);
    return item !== latest || tooOld || active
      ? {
          ...item,
          state: 'skipped',
          reason: active
            ? '같은 예약의 실행이 진행 중입니다.'
            : tooOld
              ? '24시간 보충 범위를 지났습니다.'
              : '가장 최근 예약만 보충합니다.',
        }
      : item;
  });
}
export function retryDelay(attempt: number, retryAfterMs = 0, random = Math.random): number {
  if (attempt !== 1 && attempt !== 2) throw new Error('RETRY_LIMIT');
  return Math.max(retryAfterMs, (attempt === 1 ? 2000 : 8000) + Math.floor(random() * 250));
}
export function canRetry(code: string, attempt: number): boolean {
  return attempt < 2 && ['TIMEOUT', 'NETWORK', 'RATE_LIMIT', 'SERVER_ERROR'].includes(code);
}
interface QueueEntry {
  id: string;
  work(signal: AbortSignal): Promise<unknown>;
  controller: AbortController;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
}
/** One active execution; approval waiting belongs outside this queue. */
export class SingleRunQueue {
  private waiting: QueueEntry[] = [];
  private active?: QueueEntry;
  constructor(readonly maxWaiting = 10) {
    if (!Number.isInteger(maxWaiting) || maxWaiting < 1 || maxWaiting > 10)
      throw new Error('QUEUE_LIMIT');
  }
  get activeId(): string | undefined {
    return this.active?.id;
  }
  get waitingCount(): number {
    return this.waiting.length;
  }
  enqueue<T>(id: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active?.id === id || this.waiting.some((entry) => entry.id === id))
      return Promise.reject(new Error('DUPLICATE_RUN'));
    if (this.active && this.waiting.length >= this.maxWaiting)
      return Promise.reject(new Error('QUEUE_FULL'));
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({
        id,
        work,
        controller: new AbortController(),
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.drain();
    });
  }
  cancel(id: string): boolean {
    if (this.active?.id === id) {
      this.active.controller.abort();
      return true;
    }
    const index = this.waiting.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    const [entry] = this.waiting.splice(index, 1);
    entry.controller.abort();
    entry.reject(new Error('CANCELED'));
    return true;
  }
  cancelAll(): void {
    if (this.active) this.cancel(this.active.id);
    for (const entry of [...this.waiting]) this.cancel(entry.id);
  }
  private drain(): void {
    if (this.active) return;
    const entry = this.waiting.shift();
    if (!entry) return;
    this.active = entry;
    Promise.resolve()
      .then(() => {
        if (entry.controller.signal.aborted) throw new Error('CANCELED');
        return entry.work(entry.controller.signal);
      })
      .then((value) => {
        if (entry.controller.signal.aborted) entry.reject(new Error('CANCELED'));
        else entry.resolve(value);
      }, entry.reject)
      .finally(() => {
        this.active = undefined;
        this.drain();
      });
  }
}

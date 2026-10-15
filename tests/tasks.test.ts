import { describe, expect, it } from 'vitest';
import {
  collectDueOccurrences,
  nextOccurrence,
  SingleRunQueue,
  zonedOccurrence,
} from '../packages/tasks';
import type { Job } from '../packages/contracts';
const job = (extra: Partial<Job> = {}): Job => ({
  id: 'daily',
  version: 1,
  enabled: true,
  frequency: 'weekdays',
  localTime: '09:00',
  timezone: 'Asia/Seoul',
  deviceId: 'pc',
  scope: ['Work'],
  outputPath: 'Daily',
  skillId: 'daily-work-review',
  createdAt: Date.parse('2026-10-12T00:00:00Z'),
  lastCheckedAt: Date.parse('2026-10-12T00:00:00Z'),
  missedRunPolicy: 'latest_once_within_24h',
  ...extra,
});
describe('scheduler', () => {
  it('calculates a weekday across the weekend and preserves the scheduled local date', () => {
    expect(nextOccurrence(job(), Date.parse('2026-10-16T01:00:00Z')).scheduledFor).toBe(
      '2026-10-19T00:00:00.000Z',
    );
    const due = collectDueOccurrences(job(), Date.parse('2026-10-15T15:10:00Z'), 'pc', []);
    expect(due.filter((item) => item.state === 'queued')).toEqual([
      expect.objectContaining({ date: '2026-10-15', scheduledFor: '2026-10-15T00:00:00.000Z' }),
    ]);
    expect(due.filter((item) => item.state === 'skipped')).toHaveLength(3);
  });
  it('deduplicates persisted occurrences, gates the runner and skips overlapping jobs', () => {
    const now = Date.parse('2026-10-15T01:00:00Z');
    const first = collectDueOccurrences(job(), now, 'pc', []);
    expect(collectDueOccurrences(job(), now, 'pc', first)).toEqual([]);
    expect(collectDueOccurrences(job(), now, 'other-pc', [])).toEqual([]);
    expect(collectDueOccurrences(job({ enabled: false }), now, 'pc', [])).toEqual([]);
    expect(
      collectDueOccurrences(job(), now, 'pc', [], ['daily']).every(
        (item) => item.state === 'skipped',
      ),
    ).toBe(true);
    expect(collectDueOccurrences(job({ version: 2 }), now, 'pc', first).at(-1)?.key).toContain(
      '|v2',
    );
  });
  it('moves a missing DST time to the next valid minute and executes a repeated time once', () => {
    expect(new Date(zonedOccurrence('2026-03-08', '02:30', 'America/New_York')).toISOString()).toBe(
      '2026-03-08T07:00:00.000Z',
    );
    expect(new Date(zonedOccurrence('2026-11-01', '01:30', 'America/New_York')).toISOString()).toBe(
      '2026-11-01T05:30:00.000Z',
    );
    const fallback = job({ localTime: '01:30', timezone: 'America/New_York', frequency: 'daily' });
    expect(nextOccurrence(fallback, Date.parse('2026-11-01T05:31:00Z')).date).toBe('2026-11-02');
  });
});
describe('single execution queue', () => {
  it('runs serially, limits 10 waiting, and cancels queued and active tasks', async () => {
    const queue = new SingleRunQueue();
    let release!: () => void;
    const calls: string[] = [];
    const active = queue.enqueue('active', async (signal) => {
      calls.push('active');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return signal.aborted;
    });
    await Promise.resolve();
    const pending = Array.from({ length: 10 }, (_, i) =>
      queue.enqueue(`q${i}`, async () => {
        calls.push(`q${i}`);
        return i;
      }),
    );
    await expect(queue.enqueue('overflow', async () => 1)).rejects.toThrow('QUEUE_FULL');
    await expect(queue.enqueue('active', async () => 1)).rejects.toThrow('DUPLICATE_RUN');
    const canceled = expect(pending[2]).rejects.toThrow('CANCELED');
    queue.cancel('q2');
    await canceled;
    const canceledActive = expect(active).rejects.toThrow('CANCELED');
    queue.cancel('active');
    release();
    await canceledActive;
    await Promise.all(pending.filter((_, i) => i !== 2));
    expect(calls).toEqual(['active', 'q0', 'q1', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9']);
  });
});

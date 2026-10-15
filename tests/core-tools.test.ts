import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_BUDGET, type Run } from '../packages/contracts';
import { RunGuard, ToolRegistry } from '../packages/core';
function run(): Run {
  return {
    id: 'r',
    trigger: 'manual',
    state: 'RUNNING',
    createdAt: 0,
    updatedAt: 0,
    policyVersion: 1,
    skillId: 'test',
    skillVersion: '1',
    manifestHash: 'h',
    date: '2026-10-15',
    query: '',
    scope: [],
    stage: '',
    modelCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: '가격 미설정',
    evidence: [],
  };
}
describe('tool and call budget controls', () => {
  it('rejects unknown tools, extra input fields, malformed output and rechecks policy each invocation', async () => {
    const registry = new ToolRegistry();
    let allowed = true;
    let calls = 0;
    registry.register({
      name: 'vault.read',
      input: z.object({ path: z.string() }).strict(),
      output: z.object({ text: z.string() }).strict(),
      authorize: () => {
        if (!allowed) throw new Error('revoked');
      },
      execute: async () => {
        calls++;
        return { text: 'ok' };
      },
    });
    const guard = new RunGuard(run(), DEFAULT_BUDGET);
    await expect(registry.invoke('shell.exec', {}, guard)).rejects.toThrow();
    await expect(
      registry.invoke('vault.read', { path: 'a', command: 'shell' }, guard),
    ).rejects.toThrow();
    expect(calls).toBe(0);
    await registry.invoke('vault.read', { path: 'a' }, guard);
    allowed = false;
    await expect(registry.invoke('vault.read', { path: 'a' }, guard)).rejects.toThrow('revoked');
    expect(calls).toBe(1);
    registry.register({
      name: 'search.query',
      input: z.object({}).strict(),
      output: z.object({ text: z.string() }).strict(),
      authorize: () => {},
      execute: async () => ({ text: 123 }) as any,
    });
    await expect(registry.invoke('search.query', {}, guard)).rejects.toThrow();
  });
  it('blocks calls after limits, token exhaustion and cancellation', () => {
    const controller = new AbortController();
    const r = run();
    const guard = new RunGuard(
      r,
      {
        ...DEFAULT_BUDGET,
        maxModelCalls: 1,
        maxToolCalls: 1,
        maxInputTokens: 5,
        maxOutputTokens: 4,
      },
      controller.signal,
    );
    guard.model(5);
    expect(() => guard.model(0)).toThrow();
    guard.tool();
    expect(() => guard.tool()).toThrow();
    guard.output(4);
    expect(() => guard.output(1)).toThrow();
    controller.abort();
    expect(() => guard.check()).toThrow();
    const tokenGuard = new RunGuard(run(), { ...DEFAULT_BUDGET, maxInputTokens: 1 });
    expect(() => tokenGuard.model(2)).toThrow();
  });
  it('rejects permissive schemas', () => {
    expect(() =>
      new ToolRegistry().register({
        name: 'vault.read',
        input: z.object({}),
        output: z.object({}).strict(),
        authorize: () => {},
        execute: async () => ({}),
      }),
    ).toThrow();
  });
});

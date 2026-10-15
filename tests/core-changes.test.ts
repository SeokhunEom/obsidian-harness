import { describe, expect, it } from 'vitest';
import {
  ChangeManager,
  END_MARKER,
  hashText,
  START_MARKER,
  upsertDailySection,
} from '../packages/core';
import {
  EMPTY_POLICY,
  type Policy,
  type SourceRef,
  type StateStore,
  type VaultPort,
} from '../packages/contracts';
import { emptyState } from '../packages/storage';
const ref: SourceRef = {
  id: 'source',
  kind: 'vault',
  path: 'Work/source.md',
  uri: 'vault:source',
  title: 'source',
  hash: hashText('source'),
  updatedAt: 1,
  indexedAt: 1,
};
function fixture(initial: string | null = '---\r\ncustom: keep\r\n---\r\n# Daily\r\n') {
  let text = initial;
  let open = false;
  let writes = 0;
  let currentRef: SourceRef | null = { ...ref };
  let saveCount = 0;
  let failSave = 0;
  const policy: Policy = {
    ...structuredClone(EMPTY_POLICY),
    readPaths: ['Work'],
    writePaths: ['Daily'],
  };
  const store: StateStore = {
    state: emptyState(),
    readOnly: false,
    async save() {
      saveCount++;
      if (saveCount === failSave) throw new Error('crash');
    },
  };
  const vault: VaultPort = {
    async list() {
      return [];
    },
    async read() {
      return text;
    },
    isOpen() {
      return open;
    },
    async apply(_path, baseHash, after) {
      if (hashText(text) !== baseHash) throw new Error('conflict');
      text = after;
      writes++;
    },
  };
  const manager = new ChangeManager(
    store,
    vault,
    () => policy,
    async () => currentRef,
  );
  const propose = () =>
    manager.propose({
      runId: 'run',
      targetPath: 'Daily/today.md',
      content: 'Summary',
      outputKey: 'day|skill|scope',
      sourceRefs: [ref],
    });
  return {
    manager,
    store,
    policy,
    propose,
    text: () => text,
    writes: () => writes,
    setText(v: string | null) {
      text = v;
    },
    setOpen(v: boolean) {
      open = v;
    },
    setRef(v: SourceRef | null) {
      currentRef = v;
    },
    crashAt(n: number) {
      failSave = n;
    },
  };
}
describe('daily section preservation', () => {
  it('preserves frontmatter, unknown metadata, queries and all outside bytes with CRLF', () => {
    const prefix = '---\r\nunknown: [b, a]\r\n---\r\n```dataview\r\nLIST\r\n```\r\n';
    const suffix = '\r\n\r\n- [ ] remain\r\n';
    const original = prefix + START_MARKER + '\r\nold\r\n' + END_MARKER + suffix;
    expect(upsertDailySection(original, 'one\ntwo')).toBe(
      prefix + START_MARKER + '\r\none\r\ntwo\r\n' + END_MARKER + suffix,
    );
  });
  it('inserts exactly once and repeated same body is identical', () => {
    const first = upsertDailySection('Daily\n', 'summary');
    expect(upsertDailySection(first, 'summary')).toBe(first);
  });
  it.each([
    START_MARKER,
    END_MARKER,
    `${START_MARKER}\n${START_MARKER}\n${END_MARKER}`,
    `${END_MARKER}\n${START_MARKER}`,
    `inline ${START_MARKER}\nx\n${END_MARKER}`,
    '<!-- harness:daily-work-review:star -->',
  ])('blocks malformed marker layout', (original) => {
    expect(() => upsertDailySection(original, 'safe')).toThrow();
  });
  it('rejects generated marker injection', () => {
    expect(() => upsertDailySection('', `text\n${END_MARKER}`)).toThrow();
  });
});
describe('approval-bound changes', () => {
  it('does not write before approval; applies once and preserves idempotency', async () => {
    const f = fixture();
    const before = f.text();
    const c = await f.propose();
    expect(f.text()).toBe(before);
    await f.manager.approveAndApply(c.id, c.patchHash);
    await f.manager.approveAndApply(c.id, c.patchHash);
    expect(f.writes()).toBe(1);
    expect(f.store.state.intents[0].state).toBe('applied');
  });
  it('blocks changed target, changed source, deleted source, open editor and changed policy', async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => f.setText('edited'),
      (f: ReturnType<typeof fixture>) => f.setRef({ ...ref, hash: 'new' }),
      (f: ReturnType<typeof fixture>) => f.setRef(null),
      (f: ReturnType<typeof fixture>) => f.setOpen(true),
      (f: ReturnType<typeof fixture>) => {
        f.policy.version++;
      },
    ]) {
      const f = fixture();
      const c = await f.propose();
      mutate(f);
      await expect(f.manager.approveAndApply(c.id, c.patchHash)).rejects.toThrow();
      expect(f.writes()).toBe(0);
    }
  });
  it('binds approval to path, output, evidence and expiration', async () => {
    for (const mutate of [
      (c: any) => {
        c.after += 'edited';
      },
      (c: any) => {
        c.targetUri = 'Daily/other.md';
      },
      (c: any) => {
        c.sourceRefs = [];
      },
      (c: any) => {
        c.expiresAt = 1;
      },
    ]) {
      const f = fixture();
      const c = await f.propose();
      mutate(c);
      await expect(f.manager.approveAndApply(c.id, c.patchHash)).rejects.toThrow();
      expect(f.writes()).toBe(0);
    }
  });
  it('editing issues a new changeset and rejects the former approval', async () => {
    const f = fixture();
    const old = await f.propose();
    const next = await f.manager.edit(old.id, 'Edited summary');
    expect(next.patchHash).not.toBe(old.patchHash);
    expect(old.status).toBe('rejected');
    await expect(f.manager.approveAndApply(next.id, old.patchHash)).rejects.toThrow();
    await f.manager.approveAndApply(next.id, next.patchHash);
    expect(f.text()).toContain('Edited summary');
  });
  it('rejects existing paths for new drafts', async () => {
    const f = fixture();
    await expect(
      f.manager.propose({
        runId: 'r',
        targetPath: 'Daily/today.md',
        content: 'draft',
        outputKey: 'key',
        sourceRefs: [],
        kind: 'new-draft',
      }),
    ).rejects.toThrow();
  });
  it('does not write when durable intent saving fails', async () => {
    const f = fixture();
    const c = await f.propose();
    f.crashAt(2);
    await expect(f.manager.approveAndApply(c.id, c.patchHash)).rejects.toThrow('crash');
    expect(f.writes()).toBe(0);
    await f.manager.recover();
    expect(c.status).toBe('pending');
    expect(c.approvedHash).toBeUndefined();
  });
  it('recovers a post-write crash without replaying the side effect', async () => {
    const f = fixture();
    const c = await f.propose();
    f.crashAt(3);
    await expect(f.manager.approveAndApply(c.id, c.patchHash)).rejects.toThrow('crash');
    // Simulate the last durable snapshot: prepared journal + pending change.
    c.status = 'pending';
    f.store.state.intents[0].state = 'prepared';
    await f.manager.recover();
    expect(c.status).toBe('applied');
    expect(f.writes()).toBe(1);
  });
  it('blocks recovery when neither base nor expected result matches', async () => {
    const f = fixture();
    const c = await f.propose();
    f.crashAt(2);
    await expect(f.manager.approveAndApply(c.id, c.patchHash)).rejects.toThrow();
    f.setText('third party');
    await f.manager.recover();
    expect(c.status).toBe('blocked');
    expect(f.writes()).toBe(0);
  });
  it('requires a fresh approval for rollback and rejects edited targets and created-file deletion', async () => {
    const f = fixture();
    const original = f.text();
    const c = await f.propose();
    await f.manager.approveAndApply(c.id, c.patchHash);
    const rollback = await f.manager.proposeRollback(c.id);
    expect(f.text()).not.toBe(original);
    await f.manager.approveAndApply(rollback.id, rollback.patchHash);
    expect(f.text()).toBe(original);
    const g = fixture();
    const change = await g.propose();
    await g.manager.approveAndApply(change.id, change.patchHash);
    g.setText('edited');
    await expect(g.manager.proposeRollback(change.id)).rejects.toThrow();
    const n = fixture(null);
    const created = await n.propose();
    await n.manager.approveAndApply(created.id, created.patchHash);
    await expect(n.manager.proposeRollback(created.id)).rejects.toThrow();
  });
});

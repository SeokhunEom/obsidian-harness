import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JsonStateStore, cleanupRetention, emptyState } from '../packages/storage';
const directories: string[] = [];
const stores: JsonStateStore[] = [];
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-state-test-'));
  directories.push(directory);
  const store = await JsonStateStore.open({ directory });
  stores.push(store);
  return { directory, store };
}
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});
describe('atomic state snapshots and recovery', () => {
  it('round trips state across restarts and serializes queued snapshots', async () => {
    const { directory, store } = await fixture();
    const id = store.state.deviceId;
    store.state.audit.push({ at: 1, action: 'first' });
    const first = store.save();
    store.state.audit.push({ at: 2, action: 'second' });
    const second = store.save();
    await Promise.all([first, second]);
    const backup = JSON.parse(await fs.readFile(path.join(directory, 'state.json.bak'), 'utf8'));
    expect(backup.audit).toHaveLength(1);
    await store.close();
    const reopened = await JsonStateStore.open({ directory });
    stores.push(reopened);
    expect(reopened.readOnly).toBe(false);
    expect(reopened.state.deviceId).toBe(id);
    expect(reopened.state.audit).toHaveLength(2);
  });
  it('retains valid backup in read-only mode without overwriting corrupt primary', async () => {
    const { directory, store } = await fixture();
    store.state.audit.push({ at: 1, action: 'saved' });
    await store.save();
    await store.save();
    await store.close();
    const corrupt = '{ interrupted';
    await fs.writeFile(path.join(directory, 'state.json'), corrupt);
    const recovered = await JsonStateStore.open({ directory });
    stores.push(recovered);
    expect(recovered.readOnly).toBe(true);
    expect(recovered.state.audit).toHaveLength(1);
    await expect(recovered.save()).rejects.toThrow();
    expect(await fs.readFile(path.join(directory, 'state.json'), 'utf8')).toBe(corrupt);
  });
  it('does not reset when primary is missing but backup exists', async () => {
    const { directory, store } = await fixture();
    await store.save();
    await store.close();
    await fs.unlink(path.join(directory, 'state.json'));
    const recovered = await JsonStateStore.open({ directory });
    stores.push(recovered);
    expect(recovered.readOnly).toBe(true);
    await expect(fs.access(path.join(directory, 'state.json'))).rejects.toThrow();
  });
  it('starts read-only if both snapshots are invalid and preserves them', async () => {
    const { directory, store } = await fixture();
    await store.close();
    await fs.writeFile(path.join(directory, 'state.json'), '{}');
    await fs.writeFile(path.join(directory, 'state.json.bak'), 'broken');
    const recovered = await JsonStateStore.open({ directory });
    stores.push(recovered);
    expect(recovered.readOnly).toBe(true);
    expect(await fs.readFile(path.join(directory, 'state.json.bak'), 'utf8')).toBe('broken');
  });
  it('blocks a second writer and cannot remove the first writer lock', async () => {
    const { directory, store } = await fixture();
    const second = await JsonStateStore.open({ directory });
    stores.push(second);
    expect(second.readOnly).toBe(true);
    await second.close();
    await fs.access(path.join(directory, 'state.lock'));
    await store.save();
  });
  it('rejects malformed nested state without dropping the original', async () => {
    const { directory, store } = await fixture();
    await store.close();
    const malformed = JSON.stringify({ ...emptyState(), changes: [{ id: 'unsafe' }] });
    await fs.writeFile(path.join(directory, 'state.json'), malformed);
    const recovered = await JsonStateStore.open({ directory });
    stores.push(recovered);
    expect(recovered.readOnly).toBe(true);
    expect(await fs.readFile(path.join(directory, 'state.json'), 'utf8')).toBe(malformed);
  });
  it('retains prepared intents regardless of age and removes old inactive metadata', () => {
    const s = emptyState();
    const now = 100 * 86400000;
    s.intents.push(
      {
        changeSetId: 'pending',
        targetUri: 'a.md',
        baseHash: 'a',
        expectedHash: 'b',
        state: 'prepared',
        createdAt: 1,
      },
      {
        changeSetId: 'old',
        targetUri: 'b.md',
        baseHash: 'a',
        expectedHash: 'b',
        state: 'applied',
        createdAt: 1,
      },
    );
    s.audit.push({ at: 1, action: 'old' }, { at: now, action: 'new' });
    cleanupRetention(s, now);
    expect(s.intents.map((i) => i.changeSetId)).toEqual(['pending']);
    expect(s.audit.map((a) => a.action)).toEqual(['new']);
  });
});

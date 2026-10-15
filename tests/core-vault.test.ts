import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { assertNoSymlinks, ObsidianVaultPort } from '../packages/obsidian';
import { EMPTY_POLICY } from '../packages/contracts';
import { hashText, MISSING_HASH } from '../packages/core';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function base() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-vault-test-'));
  roots.push(dir);
  return dir;
}
describe('Vault adapter safety boundaries', () => {
  it('denies intermediate and final symbolic links, including links within Vault', async () => {
    const dir = await base();
    await fs.mkdir(path.join(dir, 'actual'));
    await fs.writeFile(path.join(dir, 'actual', 'a.md'), 'secret');
    await fs.symlink(path.join(dir, 'actual'), path.join(dir, 'alias'));
    await fs.symlink(path.join(dir, 'actual', 'a.md'), path.join(dir, 'linked.md'));
    expect(() => assertNoSymlinks(dir, 'alias/a.md')).toThrow();
    expect(() => assertNoSymlinks(dir, 'linked.md')).toThrow();
    assertNoSymlinks(dir, 'actual/a.md');
  });
  it('compares the latest bytes inside Vault.process and blocks any open markdown editor', async () => {
    const dir = await base();
    await fs.mkdir(path.join(dir, 'Daily'));
    await fs.writeFile(path.join(dir, 'Daily', 'a.md'), 'original');
    let current = 'original';
    let opened = false;
    let mutateInProcess = false;
    const file = { path: 'Daily/a.md' };
    const app: any = {
      vault: {
        adapter: { getBasePath: () => dir },
        getFileByPath: () => file,
        getAbstractFileByPath: () => file,
        read: async () => current,
        process: async (_file: any, callback: any) => {
          if (mutateInProcess) current = 'concurrent';
          current = callback(current);
        },
      },
      workspace: {
        iterateAllLeaves: (fn: any) => {
          if (opened) fn({ view: { getViewType: () => 'markdown', file } });
        },
      },
    };
    const vault = new ObsidianVaultPort(app, () => ({
      ...structuredClone(EMPTY_POLICY),
      writePaths: ['Daily'],
    }));
    expect(await vault.read('Daily/a.md')).toBe('original');
    opened = true;
    await expect(vault.apply('Daily/a.md', hashText('original'), 'changed')).rejects.toThrow();
    opened = false;
    mutateInProcess = true;
    await expect(vault.apply('Daily/a.md', hashText('original'), 'changed')).rejects.toThrow();
    expect(current).toBe('concurrent');
    mutateInProcess = false;
    await vault.apply('Daily/a.md', hashText('concurrent'), 'changed');
    expect(current).toBe('changed');
    await expect(vault.apply('Daily/a.md', MISSING_HASH, 'overwrite')).rejects.toThrow();
  });
});

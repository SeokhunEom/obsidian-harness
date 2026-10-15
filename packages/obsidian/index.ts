import type { App, TFile } from 'obsidian';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { Policy, SourceDocument, VaultPort } from '../contracts';
import {
  assertRead,
  assertWrite,
  hashText,
  isReadable,
  MISSING_HASH,
  normalizeVaultPath,
  PolicyError,
} from '../core';

/** Only path validation uses fs metadata. All note reads/writes use the public Vault API. */
export function assertNoSymlinks(basePath: string, relative: string, allowMissing = false): void {
  normalizeVaultPath(relative);
  const base = realpathSync(basePath);
  let current = base;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink())
        throw new PolicyError('SYMLINK_DENIED', '심볼릭 링크 경로는 접근할 수 없습니다.');
      const real = realpathSync(current);
      const within = path.relative(base, real);
      if (within.startsWith(`..${path.sep}`) || within === '..' || path.isAbsolute(within))
        throw new PolicyError('PATH_ESCAPE', 'Vault 밖의 경로입니다.');
    } catch (error: any) {
      if (error.code === 'ENOENT' && allowMissing) return;
      throw error;
    }
  }
}
export class ObsidianVaultPort implements VaultPort {
  readonly basePath: string;
  constructor(
    private app: App,
    private getPolicy: () => Policy,
  ) {
    const adapter = app.vault.adapter as typeof app.vault.adapter & { getBasePath?: () => string };
    if (!adapter.getBasePath)
      throw new PolicyError('DESKTOP_REQUIRED', '데스크톱 파일 시스템 Vault만 지원합니다.');
    this.basePath = adapter.getBasePath();
  }
  async list(): Promise<SourceDocument[]> {
    const result: SourceDocument[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!isReadable(this.getPolicy(), { kind: 'vault', path: file.path })) continue;
      try {
        assertNoSymlinks(this.basePath, file.path);
        assertRead(this.getPolicy(), { kind: 'vault', path: file.path });
        const text = await this.app.vault.read(file);
        assertRead(this.getPolicy(), { kind: 'vault', path: file.path });
        const cache = this.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter;
        const tags = [
          ...new Set(
            [
              ...(Array.isArray(fm?.tags)
                ? fm.tags.filter((t: unknown) => typeof t === 'string')
                : typeof fm?.tags === 'string'
                  ? fm.tags.split(/[,\s]+/)
                  : []),
              ...(cache?.tags?.map((t) => t.tag) ?? []),
            ]
              .map((t: string) => t.replace(/^#/, ''))
              .filter(Boolean),
          ),
        ] as string[];
        result.push({
          id: `vault:${file.path}`,
          kind: 'vault',
          uri: `obsidian://open?path=${encodeURIComponent(path.join(this.basePath, file.path))}`,
          path: file.path,
          title: file.basename,
          hash: hashText(text),
          updatedAt: file.stat.mtime,
          indexedAt: Date.now(),
          text,
          project:
            typeof fm?.project === 'string'
              ? fm.project
              : file.path.includes('/')
                ? file.path.split('/')[0]
                : '',
          tags,
        });
      } catch {
        /* Denied, deleted, moved, or symlinked files are never indexed. */
      }
    }
    return result;
  }
  /** Read permission or write-target inspection permission. Never use this as an unchecked retrieval tool. */
  async read(relative: string): Promise<string | null> {
    try {
      assertRead(this.getPolicy(), { kind: 'vault', path: relative });
    } catch {
      assertWrite(this.getPolicy(), relative);
    }
    assertNoSymlinks(this.basePath, relative, true);
    const file = this.app.vault.getFileByPath(relative);
    if (!file) {
      if (this.app.vault.getAbstractFileByPath(relative))
        throw new PolicyError('TARGET_NOT_FILE', '파일이 아닌 경로입니다.');
      return null;
    }
    const text = await this.app.vault.read(file);
    try {
      assertRead(this.getPolicy(), { kind: 'vault', path: relative });
    } catch {
      assertWrite(this.getPolicy(), relative);
    }
    assertNoSymlinks(this.basePath, relative);
    return text;
  }
  isOpen(relative: string): boolean {
    let open = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as typeof leaf.view & { file?: TFile };
      if (view.getViewType() === 'markdown' && view.file?.path === relative) open = true;
    });
    return open;
  }
  async apply(relative: string, baseHash: string, after: string): Promise<void> {
    assertWrite(this.getPolicy(), relative);
    assertNoSymlinks(this.basePath, relative, true);
    if (this.isOpen(relative))
      throw new PolicyError('EDITOR_OPEN', '대상 노트를 모든 편집 창에서 닫아 주세요.');
    const file = this.app.vault.getFileByPath(relative);
    if (baseHash === MISSING_HASH) {
      if (this.app.vault.getAbstractFileByPath(relative))
        throw new PolicyError('TARGET_EXISTS', '새 파일 경로가 이미 존재합니다.');
      const folders = relative.split('/').slice(0, -1);
      for (let i = 1; i <= folders.length; i++) {
        const folder = folders.slice(0, i).join('/');
        assertNoSymlinks(this.basePath, folder, true);
        if (!this.app.vault.getAbstractFileByPath(folder))
          await this.app.vault.createFolder(folder);
      }
      assertWrite(this.getPolicy(), relative);
      assertNoSymlinks(this.basePath, relative, true);
      if (this.isOpen(relative) || this.app.vault.getAbstractFileByPath(relative))
        throw new PolicyError('TARGET_EXISTS', '적용 중 대상 상태가 바뀌었습니다.');
      await this.app.vault.create(relative, after);
      return;
    }
    if (!file) throw new PolicyError('TARGET_CHANGED', '대상 파일이 삭제되거나 이동했습니다.');
    await this.app.vault.process(file, (current) => {
      assertWrite(this.getPolicy(), relative);
      assertNoSymlinks(this.basePath, relative);
      if (this.isOpen(relative))
        throw new PolicyError('EDITOR_OPEN', '적용 중 편집 창이 열렸습니다.');
      if (hashText(current) !== baseHash)
        throw new PolicyError('TARGET_CHANGED', '최신 원문이 승인 기준과 다릅니다.');
      return after;
    });
  }
}

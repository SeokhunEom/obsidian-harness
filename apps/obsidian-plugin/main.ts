import { Plugin, FileSystemAdapter, Notice, TFile } from 'obsidian';
import { createHash } from 'node:crypto';
import { lstatSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ChatGPTAuth, ProviderError, type SecretStore } from '../../packages/providers';
import { boundedHttp } from '../../packages/providers/http';
import { JsonStateStore, localStateDirectory, cleanupRetention } from '../../packages/storage';
import { normalizeVaultPath, isReadable, PolicyError } from '../../packages/core';
import { GithubConnector } from '../../packages/connect';
import { loadSkill, BUILTIN_SKILL } from '../../packages/agent';
import { HarnessRuntime } from './runtime';
import { DEFAULT_SETTINGS, loadSettings, type HarnessSettings, today } from './settings';
import { HarnessView, VIEW_TYPE } from './view';
import { HarnessSettingTab } from './setting-tab';

export default class HarnessPlugin extends Plugin {
  settings: HarnessSettings = structuredClone(DEFAULT_SETTINGS);
  runtime?: HarnessRuntime;
  auth?: ChatGPTAuth;
  secrets!: SecretStore;
  storagePath = '';
  starting = false;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  async onload(): Promise<void> {
    this.settings = loadSettings(await this.loadData());
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
      new Notice('Harness는 데스크톱 파일 Vault 전용입니다.');
      return;
    }
    this.storagePath = localStateDirectory(this.app.vault.adapter.getBasePath());
    if (!existsSync(path.join(this.storagePath, 'state.json')))
      this.settings.storageConfirmed = false;
    this.registerView(VIEW_TYPE, (leaf) => new HarnessView(leaf, this));
    this.addRibbonIcon('bot', 'Obsidian Harness 열기', () => void this.openPanel());
    this.addCommand({ id: 'open', name: '도우미 열기', callback: () => void this.openPanel() });
    this.addCommand({
      id: 'daily-review',
      name: '오늘 업무 정리 초안',
      callback: () =>
        this.action(async () => {
          const rt = this.requireRuntime();
          await rt.enqueue({
            query: '오늘 확인된 업무와 미완료 항목, 다음 행동을 정리해줘.',
            date: today(),
            mode: 'daily',
          });
          await this.openPanel();
        }),
    });
    this.addCommand({
      id: 'stop',
      name: '현재 실행 중단',
      callback: () => this.runtime?.cancelAll(),
    });
    this.addSettingTab(new HarnessSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.storageConfirmed) this.action(() => this.start());
      const refresh = () => {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
          if (this.runtime && !this.disposed) this.action(() => this.runtime!.refreshIndex());
        }, 350);
      };
      this.registerEvent(this.app.vault.on('create', refresh));
      this.registerEvent(this.app.vault.on('modify', refresh));
      this.registerEvent(
        this.app.vault.on('delete', (file) => {
          if (this.runtime)
            this.action(async () => {
              await this.runtime!.index.remove(file.path);
              await this.runtime!.refreshIndex();
            });
        }),
      );
      this.registerEvent(
        this.app.vault.on('rename', (file, old) => {
          if (this.runtime)
            this.action(async () => {
              const rt = this.runtime!;
              const document = (await rt.vault.list()).find((d) => d.path === file.path);
              if (document) await rt.index.rename(old, document);
              else await rt.index.remove(old);
              await rt.refreshIndex();
            });
        }),
      );
    });
    this.registerInterval(
      window.setInterval(() => {
        if (this.runtime) this.action(() => this.runtime!.tick());
      }, 30000),
    );
  }
  async start(): Promise<void> {
    if (this.starting || this.runtime) return;
    this.starting = true;
    try {
      if (!this.settings.storageConfirmed) throw new Error('설정에서 운영 저장 위치를 확인하세요.');
      const store = await JsonStateStore.open({ directory: this.storagePath });
      const secretId = (key: string) =>
        /^[a-z0-9-]+$/.test(key)
          ? key
          : `harness-${createHash('sha256')
              .update(store.state.deviceId + ':' + key)
              .digest('hex')
              .slice(0, 40)}`;
      this.secrets = {
        get: async (key) => this.app.secretStorage.getSecret(secretId(key)),
        set: async (key, value) => {
          this.app.secretStorage.setSecret(secretId(key), value);
        },
        delete: async (key) => {
          this.app.secretStorage.setSecret(secretId(key), '');
        },
      };
      this.auth = new ChatGPTAuth(this.secrets, store.state.deviceId);
      this.runtime = new HarnessRuntime(
        this.app,
        store,
        () => this.settings,
        this.secrets,
        this.auth,
        () => this.renderViews(),
      );
      this.configureGithub();
      this.runtime.beforeRun = async () => {
        if (this.settings.skillFolder) await this.activateSkill(false);
      };
      await this.runtime.initialize();
      if (this.settings.skillFolder) {
        try {
          await this.activateSkill(false);
        } catch {
          new Notice(
            '사용자 Skill이 바뀌었거나 유효하지 않습니다. 설정에서 다시 검토·활성화하세요.',
          );
        }
      }
      if (!store.readOnly) {
        cleanupRetention(store.state, Date.now(), {
          logDays: this.settings.retentionDays,
          artifactDays: this.settings.artifactDays,
          snapshotDays: this.settings.snapshotDays,
        });
        await store.save();
        await this.runtime.refreshIndex();
        await this.runtime.tick();
      }
    } finally {
      this.starting = false;
      this.renderViews();
    }
  }
  configureGithub(): void {
    if (!this.runtime) return;
    const rt = this.runtime;
    rt.revalidateGithub = (doc) => this.githubConnector().revalidate(doc);
    rt.syncGithub = async (signal) => {
      const connector = this.githubConnector();
      for (const repo of this.settings.policy.githubRepos) {
        let state = rt.store.state.github.find((s) => s.repo === repo);
        if (!state) {
          state = { repo, status: 'idle', documents: [] };
          rt.store.state.github.push(state);
        }
        await connector.sync(state, signal);
      }
      await rt.refreshIndex();
    };
  }
  githubConnector(): GithubConnector {
    const settings = structuredClone(this.settings);
    // Node transport avoids renderer CORS while retaining a fixed HTTPS API destination.
    const adapter = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = { 'user-agent': 'Obsidian-Harness/0.1.0' };
      new Headers(init?.headers).forEach((v, k) => {
        headers[k] = v;
      });
      const result = await boundedHttp({
        url: String(input),
        method: 'GET',
        headers,
        signal: init?.signal ?? undefined,
        maxBytes: 8 * 1024 * 1024,
        timeoutMs: 30000,
      });
      return new Response(result.body, { status: result.status, headers: result.headers });
    }) as typeof fetch;
    return new GithubConnector(
      {
        apiBase: settings.githubBaseUrl,
        repositories: [...settings.policy.githubRepos],
        maxItems: settings.githubMaxItems,
        days: 30,
      },
      {
        canRead: (repo) =>
          this.settings.githubEnabled &&
          this.settings.githubBaseUrl === settings.githubBaseUrl &&
          this.settings.policy.githubRepos.includes(repo),
        getToken: async () =>
          settings.githubSecret
            ? ((await this.secrets.get(settings.githubSecret)) ?? undefined)
            : undefined,
        fetch: adapter,
        save: async () => {
          await this.runtime?.save();
        },
        onRevoke: async (repo) => {
          const state = this.runtime?.store.state.github.find((s) => s.repo === repo);
          if (state) {
            state.status = 'blocked';
            state.documents = [];
            state.cursor = undefined;
          }
          await this.runtime?.index.invalidatePolicy();
          await this.runtime?.save();
        },
      },
    );
  }
  async saveSettings(policyChanged = true): Promise<void> {
    if (policyChanged) {
      this.settings.policy.version++;
      this.runtime?.cancelAll();
      this.auth?.stopRequests();
    }
    await this.saveData(this.settings);
    if (this.runtime && policyChanged) {
      for (const state of this.runtime.store.state.github)
        if (
          !this.settings.githubEnabled ||
          !this.settings.policy.githubRepos.includes(state.repo)
        ) {
          state.status = 'blocked';
          state.documents = [];
          state.cursor = undefined;
        }
      for (const memory of this.runtime.store.state.memories)
        if (!memory.sourceRefs.every((r) => isReadable(this.settings.policy, r)))
          memory.status = 'inactive';
      this.configureGithub();
      await this.runtime.policyChanged();
    }
    this.renderViews();
  }
  async readSkillFile(name: string): Promise<string> {
    const adapter = this.app.vault.adapter as FileSystemAdapter;
    const folder = normalizeVaultPath(this.settings.skillFolder);
    const relative = normalizeVaultPath(`${folder}/${name}`);
    let current = adapter.getBasePath();
    for (const segment of relative.split('/')) {
      current = path.join(current, segment);
      if (lstatSync(current).isSymbolicLink())
        throw new PolicyError('PATH_SYMLINK', 'Skill 경로에 심볼릭 링크를 사용할 수 없습니다.');
    }
    const file = this.app.vault.getAbstractFileByPath(relative);
    if (!(file instanceof TFile)) throw new Error('Skill 파일을 찾을 수 없습니다.');
    return this.app.vault.read(file);
  }
  async activateSkill(approve: boolean, expectedHash?: string): Promise<void> {
    const rt = this.requireRuntime();
    if (!this.settings.skillFolder) {
      rt.skill = BUILTIN_SKILL;
      this.settings.approvedSkillHash = '';
      await this.saveSettings();
      return;
    }
    const skill = loadSkill(
      await this.readSkillFile('manifest.json'),
      await this.readSkillFile('instructions.md'),
    );
    if (approve && expectedHash && skill.manifestHash !== expectedHash)
      throw new Error('SKILL_CHANGED: 검토 후 Skill 파일이 바뀌었습니다. 다시 검토하세요.');
    if (!approve && skill.manifestHash !== this.settings.approvedSkillHash)
      throw new Error('SKILL_CHANGED');
    rt.skill = skill;
    if (approve) {
      this.settings.approvedSkillHash = skill.manifestHash;
      await this.saveSettings();
    }
  }
  requireRuntime(): HarnessRuntime {
    if (!this.runtime) throw new Error('먼저 Harness 설정에서 운영 저장 위치를 확인하세요.');
    if (this.runtime.store.readOnly)
      throw new PolicyError(
        'STATE_READ_ONLY',
        '운영 저장소 복구 모드입니다. 로컬 검색만 사용할 수 있습니다.',
      );
    return this.runtime;
  }
  action(work: () => Promise<unknown>): void {
    void work().catch((error) => {
      new Notice(this.safeError(error), 8000);
    });
  }
  safeError(error: unknown): string {
    if (error instanceof PolicyError || error instanceof ProviderError)
      return `${error.code}: ${error.message}`;
    if (
      error instanceof Error &&
      /^(먼저|설정에서|Skill|SKILL_|DATE:|INPUT:|INDEX_|PAUSED|CONTEXT_|OUTPUT_)/.test(
        error.message,
      )
    )
      return error.message;
    return '작업을 완료하지 못했습니다. 설정·연결 상태·자료 권한을 확인하세요.';
  }
  async openPanel(): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
  }
  renderViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof HarnessView) leaf.view.refresh();
    }
  }
  onunload(): void {
    this.disposed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.auth?.stopRequests();
    if (this.runtime) void this.runtime.close().catch(() => undefined);
  }
}

import { App, PluginSettingTab, Setting, SecretComponent, Notice, Modal } from 'obsidian';
import { randomUUID } from 'node:crypto';
import type HarnessPlugin from './main';
import {
  getDestination,
  createGenerationProvider,
  createEmbeddingProvider,
  testGeneration,
  type ProviderConfig,
} from '../../packages/providers';
import { loadSkill } from '../../packages/agent';
import { dailyTarget } from './settings';
import { nextOccurrence, validateJob } from '../../packages/tasks';
import { cleanupRetention } from '../../packages/storage';
import type { Job, MemoryEntry, SourceRef } from '../../packages/contracts';
import { normalizeVaultPath } from '../../packages/core';
const lines = (text: string) =>
  text
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);
export class HarnessSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: HarnessPlugin,
  ) {
    super(app, plugin);
  }
  private do(work: () => Promise<unknown>): void {
    this.plugin.action(async () => {
      await work();
      this.display();
    });
  }
  display(): void {
    const el = this.containerEl;
    el.empty();
    el.addClass('harness-settings');
    const p = this.plugin,
      s = p.settings;
    el.createEl('h2', { text: 'Obsidian Harness · MVP' });
    el.createDiv({
      cls: 'harness-warning',
      text: '업무용 PC 검증용 MVP입니다. 최초 설정은 자료 읽기·모델 전송·예약이 모두 비활성입니다. 운영 이력과 검색 원문은 아래 기기 로컬 경로에 저장되며 자체 암호화하지 않습니다. Obsidian의 다른 플러그인과 운영체제 접근을 격리하는 보안 경계는 아닙니다.',
    });
    new Setting(el)
      .setName('운영 저장 위치')
      .setDesc(p.storagePath)
      .addButton((b) =>
        b
          .setButtonText(s.storageConfirmed ? '확인됨' : '이 위치를 확인하고 시작')
          .setDisabled(s.storageConfirmed)
          .onClick(() =>
            this.do(async () => {
              s.storageConfirmed = true;
              await p.saveSettings(false);
              await p.start();
            }),
          ),
      );
    new Setting(el)
      .setName('전체 일시정지')
      .setDesc('새 모델 요청, 예약, 적용을 중단합니다.')
      .addToggle((t) =>
        t.setValue(s.paused).onChange((v) =>
          this.do(async () => {
            s.paused = v;
            await p.saveSettings();
          }),
        ),
      );
    el.createEl('h3', { text: '1. 읽기·쓰기 범위' });
    el.createDiv({
      cls: 'harness-muted',
      text: 'Vault 상대 경로를 줄별로 입력합니다. 예: Work/ProjectA. 명시적으로 전체 범위를 원할 때만 . 을 입력하세요. .obsidian, .git, .trash와 운영 폴더는 검색에서 제외됩니다.',
    });
    this.pathSetting('읽기 허용 경로', s.policy.readPaths, (v) => (s.policy.readPaths = v));
    this.pathSetting(
      '읽기·쓰기 제외 경로',
      s.policy.excludedPaths,
      (v) => (s.policy.excludedPaths = v),
    );
    this.pathSetting('쓰기 허용 경로', s.policy.writePaths, (v) => (s.policy.writePaths = v));
    this.pathSetting(
      '운영/생성 폴더 · 검색 제외',
      s.policy.operationalPaths,
      (v) => (s.policy.operationalPaths = v),
    );
    this.text(
      'Daily Note 경로 패턴',
      '{date}, {YYYY}, {MM}, {DD}를 지원합니다. 예: Daily/{date}.md',
      s.dailyPath,
      (v) => (s.dailyPath = v),
    );
    this.text(
      '새 초안 폴더',
      '쓰기 허용 경로에도 명시해야 합니다.',
      s.draftFolder,
      (v) => (s.draftFolder = v),
    );
    el.createDiv({
      cls: 'harness-muted',
      text: '기존 frontmatter의 project, tags를 읽고 원문 속성을 변경하지 않습니다. 프로젝트 속성이 없으면 폴더를 검색 프로젝트로 사용합니다.',
    });
    el.createEl('h3', { text: '2. 생성 모델' });
    this.provider('generation');
    el.createEl('h3', { text: '3. 임베딩 모델' });
    this.provider('embedding');
    el.createDiv({
      cls: 'harness-muted',
      text: 'ChatGPT 로그인은 생성 전용입니다. 임베딩은 Ollama 또는 사내 서버를 별도로 지정하세요. 모델·주소·차원이 바뀌면 기존 벡터를 섞지 않고 키워드 전용으로 전환합니다.',
    });
    if (p.runtime) {
      const index = p.runtime.store.state.index;
      new Setting(el)
        .setName('색인 상태')
        .setDesc(
          `문서 ${index.documents.length}, 조각 ${index.chunks.length}, 벡터 대기 ${index.pending}, 실패 ${index.failed}`,
        )
        .addButton((b) =>
          b
            .setButtonText('키워드 갱신')
            .onClick(() => this.do(() => p.requireRuntime().refreshIndex())),
        )
        .addButton((b) =>
          b.setButtonText('중단').onClick(() => this.do(() => p.requireRuntime().pauseIndex())),
        )
        .addButton((b) =>
          b.setButtonText('재구축').onClick(() =>
            this.do(async () => {
              await p.requireRuntime().index.rebuild();
              await p.requireRuntime().refreshIndex();
            }),
          ),
        );
      new Setting(el)
        .setName('임베딩 시작/재개')
        .setDesc(
          `최대 ${index.chunks.length}개 조각 · 대상 ${s.embedding.baseUrl} · 가격 미설정. 이 버튼을 눌러야 자료 임베딩을 전송합니다.`,
        )
        .addButton((b) =>
          b
            .setButtonText('범위 확인 후 임베딩')
            .onClick(() =>
              new ConfirmModal(
                p.app,
                '임베딩 전송 확인',
                `${s.embedding.model}\n${s.embedding.baseUrl}\n현재 허용된 ${index.chunks.length}개 조각 중 전송 권한이 있는 자료를 처리합니다. 비용은 미설정입니다.`,
                () => this.do(() => p.requireRuntime().embedIndex()),
              ).open(),
            ),
        );
    }
    el.createEl('h3', { text: '4. GitHub · 선택 기능' });
    new Setting(el).setName('GitHub 읽기 연결').addToggle((t) =>
      t.setValue(s.githubEnabled).onChange((v) =>
        this.do(async () => {
          s.githubEnabled = v;
          await p.saveSettings();
        }),
      ),
    );
    this.text(
      'GitHub API 주소',
      'GitHub Enterprise는 https://호스트/api/v3. 임의 URL 추적이나 쓰기 API는 제공하지 않습니다.',
      s.githubBaseUrl,
      (v) => {
        s.githubBaseUrl = v;
        if (p.runtime) p.runtime.store.state.github = [];
      },
    );
    this.pathSetting(
      '허용 저장소 owner/repo',
      s.policy.githubRepos,
      (v) => (s.policy.githubRepos = v),
      false,
    );
    const ghSecret = new Setting(el)
      .setName('GitHub 토큰 비밀값 이름')
      .setDesc(
        'Metadata, Issues, Pull requests 읽기 권한. 조직 사용 정책에 맞는 경우에만 연결하세요.',
      );
    new SecretComponent(this.app, ghSecret.controlEl).setValue(s.githubSecret).onChange((v) =>
      this.do(async () => {
        s.githubSecret = v ?? '';
        await p.saveSettings();
      }),
    );
    el.createDiv({
      cls: 'harness-muted',
      text: '열린 Issue·PR + 최근 30일 변경 항목 및 대화 댓글 · 저장소당 최대 1,000개(댓글 포함). 코드 diff/인라인 코드 리뷰 댓글은 수집하지 않습니다.',
    });
    new Setting(el)
      .setName('GitHub 수동 확인')
      .addButton((b) =>
        b.setButtonText('연결 시험').onClick(() =>
          this.do(async () => {
            p.requireRuntime();
            if (!s.githubEnabled) throw new Error('INPUT: GitHub 연결을 먼저 활성화하세요.');
            const connector = p.githubConnector();
            for (const repo of s.policy.githubRepos) {
              const result = await connector.probe(repo);
              new Notice(`${repo}: ${result.message}`, 8000);
            }
          }),
        ),
      )
      .addButton((b) =>
        b.setButtonText('지금 동기화').onClick(() =>
          this.do(async () => {
            await p.requireRuntime().syncGithub?.();
          }),
        ),
      );
    for (const state of p.runtime?.store.state.github ?? [])
      el.createDiv({
        cls: 'harness-muted',
        text: `${state.repo}: ${state.status} · ${state.documents.length}개 · ${state.message ?? ''} · 마지막 성공 ${state.lastSuccessAt ? new Date(state.lastSuccessAt).toLocaleString() : '없음'}`,
      });
    el.createEl('h3', { text: '5. 예약 · 앱이 열려 있을 때 실행' });
    el.createDiv({
      cls: 'harness-warning',
      text: '앱 종료·절전 중 실행하지 않습니다. 재시작 시 24시간 내 최신 1회를 원래 예정된 현지 날짜로 보충합니다. 이 기기만 실행하도록 지정하며, 단절된 다른 기기에서 함께 활성화하면 전역 중복 방지를 보장하지 않습니다.',
    });
    if (p.runtime) this.jobs();
    el.createEl('h3', { text: '6. 확인된 기억과 Skill' });
    if (p.runtime) this.memories();
    this.text(
      '사용자 Skill 폴더',
      '빈칸은 기본 daily-work-review. 폴더에 manifest.json, instructions.md를 둡니다. 변경 시 다시 검토해야 하며 권한은 늘어나지 않습니다.',
      s.skillFolder,
      (v) => {
        s.skillFolder = v;
        s.approvedSkillHash = '';
        if (p.runtime) p.runtime.skill = { ...p.runtime.skill };
      },
    );
    new Setting(el).setName('Skill 검토·활성화').addButton((b) =>
      b.setButtonText('파일 검토').onClick(() =>
        this.do(async () => {
          p.requireRuntime();
          if (!s.skillFolder) {
            await p.activateSkill(true);
            return;
          }
          const manifest = await p.readSkillFile('manifest.json'),
            instructions = await p.readSkillFile('instructions.md');
          const reviewed = loadSkill(manifest, instructions);
          new ConfirmModal(p.app, 'Skill 활성화', manifest + '\n\n' + instructions, () =>
            this.do(() => p.activateSkill(true, reviewed.manifestHash)),
          ).open();
        }),
      ),
    );
    el.createEl('h3', { text: '7. 실행 한도와 데이터 관리' });
    this.number(
      '생성 모델 컨텍스트 한도 (보수 예산)',
      s.generationContextTokens,
      (v) => (s.generationContextTokens = v),
    );
    for (const [key, label] of [
      ['maxModelCalls', 'Run 모델 호출 상한'],
      ['maxToolCalls', 'Run 도구 호출 상한'],
      ['maxInputTokens', 'Run 입력 토큰 예산'],
      ['maxOutputTokens', 'Run 출력 토큰 예산'],
      ['activeTimeoutMs', 'Run 활성 시간 (ms)'],
      ['requestTimeoutMs', '요청 시간 제한 (ms)'],
    ] as const)
      this.number(label, s.budget[key], (v) => (s.budget[key] = v));
    this.number('실행 이력 보존 일수', s.retentionDays, (v) => (s.retentionDays = v));
    this.number('임시 초안 보존 일수', s.artifactDays, (v) => (s.artifactDays = v));
    this.number('역변경 스냅샷 보존 일수', s.snapshotDays, (v) => (s.snapshotDays = v));
    if (p.runtime) {
      el.createDiv({
        cls: 'harness-muted',
        text: `저장량: Run ${p.runtime.store.state.runs.length}, 변경안 ${p.runtime.store.state.changes.length}, 기억 ${p.runtime.store.state.memories.length}. 원문/전체 프롬프트 진단 로그는 남기지 않습니다. 임시 결과와 복구용 원문은 보존 기간 동안 로컬 상태에 포함됩니다.`,
      });
      new Setting(el)
        .setName('철회 자료·만료 기록 지금 정리')
        .setDesc('사용자 Markdown은 삭제하지 않습니다. OS 백업까지 삭제를 보장하지 않습니다.')
        .addButton((b) =>
          b.setButtonText('운영 데이터 정리').onClick(() =>
            this.do(async () => {
              const rt = p.requireRuntime();
              await rt.policyChanged();
              cleanupRetention(rt.store.state, Date.now(), {
                logDays: s.retentionDays,
                artifactDays: s.artifactDays,
                snapshotDays: s.snapshotDays,
              });
              await rt.save();
              await rt.save();
              new Notice('운영 저장소 정리를 완료했습니다.');
            }),
          ),
        );
    }
  }
  private text(name: string, desc: string, value: string, set: (v: string) => void): void {
    let draft = value;
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((t) => t.setValue(value).onChange((v) => (draft = v)))
      .addButton((b) =>
        b.setButtonText('저장').onClick(() =>
          this.do(async () => {
            set(draft.trim());
            await this.plugin.saveSettings();
          }),
        ),
      );
  }
  private pathSetting(
    name: string,
    value: string[],
    set: (v: string[]) => void,
    vault = true,
  ): void {
    let draft = value.join('\n');
    new Setting(this.containerEl)
      .setName(name)
      .addTextArea((t) => t.setValue(draft).onChange((v) => (draft = v)))
      .addButton((b) =>
        b.setButtonText('범위 저장').onClick(() =>
          this.do(async () => {
            const paths = lines(draft);
            if (vault) paths.forEach((v) => normalizeVaultPath(v, true));
            else if (paths.some((v) => !/^[-\w.]+\/[-\w.]+$/.test(v)))
              throw new Error('INPUT: owner/repo 형식이 필요합니다.');
            set(paths);
            await this.plugin.saveSettings();
          }),
        ),
      );
  }
  private number(name: string, value: number, set: (v: number) => void): void {
    let draft = String(value);
    new Setting(this.containerEl)
      .setName(name)
      .addText((t) => t.setValue(draft).onChange((v) => (draft = v)))
      .addButton((b) =>
        b.setButtonText('저장').onClick(() =>
          this.do(async () => {
            const n = Number(draft);
            if (!Number.isSafeInteger(n) || n < 1 || n > 10000000)
              throw new Error('INPUT: 1~10000000 정수를 입력하세요.');
            set(n);
            await this.plugin.saveSettings();
          }),
        ),
      );
  }
  private provider(key: 'generation' | 'embedding'): void {
    const p = this.plugin,
      s = p.settings,
      config = s[key],
      el = this.containerEl;
    new Setting(el).setName('제공자').addDropdown((d) => {
      d.addOption('openai-compatible', 'OpenAI 호환 chat/completions').addOption(
        'ollama',
        'Ollama native',
      );
      if (key === 'generation') d.addOption('chatgpt', 'ChatGPT 로그인');
      d.setValue(config.kind).onChange((v) =>
        this.do(async () => {
          config.kind = v as ProviderConfig['kind'];
          config.enabled = false;
          config.baseUrl =
            v === 'chatgpt'
              ? 'https://api.openai.com/v1'
              : v === 'ollama'
                ? 'http://127.0.0.1:11434'
                : 'http://127.0.0.1:11434/v1';
          await p.saveSettings();
        }),
      );
    });
    if (config.kind !== 'chatgpt') {
      this.text(
        '서버 주소',
        'OpenAI 호환: /v1까지 입력. Ollama native: http://127.0.0.1:11434',
        config.baseUrl,
        (v) => (config.baseUrl = v),
      );
      new Setting(el)
        .setName('사내망 HTTP 명시적 허용')
        .setDesc(
          '기본은 HTTPS 또는 루프백 HTTP만 허용합니다. 사내망 주소라도 모델 전송 범위는 별도 설정합니다.',
        )
        .addToggle((t) =>
          t.setValue(!!config.allowPrivateHttp).onChange((v) =>
            this.do(async () => {
              config.allowPrivateHttp = v;
              await p.saveSettings();
            }),
          ),
        );
      const secret = new Setting(el)
        .setName('API 키 비밀값 이름')
        .setDesc(
          '키가 없는 Ollama는 비워 두세요. 실제 키는 Obsidian 비밀값 저장소에서 관리합니다.',
        );
      new SecretComponent(this.app, secret.controlEl)
        .setValue(config.apiKeySecret ?? '')
        .onChange((v) =>
          this.do(async () => {
            config.apiKeySecret = v ?? '';
            await p.saveSettings();
          }),
        );
    } else {
      el.createDiv({
        cls: 'harness-muted',
        text: '브라우저에서 ChatGPT 계정으로 로그인합니다. 계정의 모델 사용 권한/조직 정책에 따라 사용 가능 여부가 다릅니다. 로그인 자체가 자료 전송 동의는 아닙니다.',
      });
      new Setting(el)
        .setName('ChatGPT 계정')
        .addButton((b) =>
          b.setButtonText('ChatGPT 로그인').onClick(() =>
            this.do(async () => {
              p.requireRuntime();
              const { shell } = require('electron') as {
                shell: { openExternal: (url: string) => Promise<void> };
              };
              await p.auth!.signIn((url) => shell.openExternal(url));
              new Notice('ChatGPT 로그인 완료. 모델 목록을 불러와 선택하세요.');
            }),
          ),
        )
        .addButton((b) => b.setButtonText('로그인 중단').onClick(() => p.auth?.stopRequests()))
        .addButton((b) =>
          b.setButtonText('로그아웃').onClick(() =>
            this.do(async () => {
              const result = await p.auth!.signOut();
              new Notice(
                result.remoteRevocationConfirmed
                  ? '로그아웃 및 원격 권한 철회 완료'
                  : '로컬 로그아웃 완료. 원격 철회는 확인되지 않았습니다. ChatGPT 설정의 앱 권한을 확인하세요.',
                10000,
              );
            }),
          ),
        );
      if (p.auth) {
        const accounts = el.createDiv();
        void p.auth
          .listAccounts()
          .then((list) => {
            if (!accounts.isConnected) return;
            for (const a of list)
              new Setting(accounts)
                .setName(a.label)
                .setDesc(
                  `${a.signedIn ? '로그인됨' : '재로그인 필요'}${a.active ? ' · 현재 선택' : ''}`,
                )
                .addButton((b) =>
                  b
                    .setButtonText('선택')
                    .setDisabled(a.active)
                    .onClick(() => this.do(() => p.auth!.selectAccount(a.id))),
                );
          })
          .catch(() => accounts.createDiv({ text: '계정 상태를 읽을 수 없습니다.' }));
      }
      new Setting(el).setName('허용 모델 목록').addButton((b) =>
        b.setButtonText('불러오기').onClick(() =>
          this.do(async () => {
            p.requireRuntime();
            const models = await p.auth!.listModels();
            new ModelModal(
              this.app,
              models.map((m) => m.id),
              (model) =>
                this.do(async () => {
                  config.model = model;
                  await p.saveSettings();
                }),
            ).open();
          }),
        ),
      );
    }
    this.text(
      '모델 ID',
      '업무용 서버에 설치된 정확한 모델 이름을 입력하세요.',
      config.model,
      (v) => {
        config.model = v;
        if (key === 'embedding') s.embeddingDimensions = 0;
      },
    );
    if (key === 'generation')
      new Setting(el).setName('구조화 출력 방식').addDropdown((d) =>
        d
          .addOption('json-schema', 'JSON Schema')
          .addOption('json-object', 'JSON Object')
          .addOption('text', '텍스트 → 검증')
          .setValue(config.structuredOutput)
          .onChange((v) =>
            this.do(async () => {
              config.structuredOutput = v as ProviderConfig['structuredOutput'];
              await p.saveSettings();
            }),
          ),
      );
    new Setting(el).setName('연결 활성화').addToggle((t) =>
      t.setValue(config.enabled).onChange((v) =>
        this.do(async () => {
          config.enabled = v;
          await p.saveSettings();
        }),
      ),
    );
    new Setting(el)
      .setName('예시 문자열로 연결 시험')
      .setDesc(
        '노트 내용을 보내지 않습니다. 생성 모델은 JSON 계약, 임베딩은 실제 차원을 확인합니다. 모델의 도구 호출은 사용하지 않습니다.',
      )
      .addButton((b) =>
        b.setButtonText('시험').onClick(() =>
          this.do(async () => {
            p.requireRuntime();
            if (key === 'generation')
              await testGeneration(createGenerationProvider(config, p.secrets, p.auth));
            else {
              const rows = await createEmbeddingProvider(config, p.secrets).embed([
                'Harness connection test',
              ]);
              s.embeddingDimensions = rows[0].length;
              await p.saveSettings();
            }
            new Notice(
              `연결 시험 통과${key === 'embedding' ? ' · ' + s.embeddingDimensions + '차원' : ''}`,
            );
          }),
        ),
      );
    let destination = '';
    try {
      destination = getDestination(config);
    } catch {
      /* Invalid endpoint remains ungranted. */
    }
    const grant = s.policy.transfers.find((g) => g.destination === destination);
    let paths = grant?.paths.join('\n') ?? '',
      repos = grant?.githubRepos.join('\n') ?? '',
      input = grant?.allowUserInput ?? false;
    el.createDiv({
      cls: 'harness-muted',
      text: `이 모델로 전송할 경로와 저장소를 별도로 지정합니다. 목적지: ${destination || '주소/모델 설정 필요'}`,
    });
    new Setting(el)
      .setName('모델 전송 허용 노트 경로')
      .addTextArea((t) => t.setValue(paths).onChange((v) => (paths = v)));
    new Setting(el)
      .setName('모델 전송 허용 GitHub 저장소')
      .addTextArea((t) => t.setValue(repos).onChange((v) => (repos = v)));
    new Setting(el)
      .setName('직접 입력한 요청/검색어 전송 허용')
      .addToggle((t) => t.setValue(input).onChange((v) => (input = v)));
    new Setting(el)
      .setName('이 목적지의 전송 정책 저장')
      .addButton((b) =>
        b.setButtonText('명시한 범위 허용').onClick(() =>
          this.do(async () => {
            const target = getDestination(config),
              approved = lines(paths);
            approved.forEach((v) => normalizeVaultPath(v, true));
            s.policy.transfers = s.policy.transfers.filter((g) => g.destination !== target);
            s.policy.transfers.push({
              destination: target,
              paths: approved,
              githubRepos: lines(repos),
              allowUserInput: input,
            });
            await p.saveSettings();
          }),
        ),
      )
      .addButton((b) =>
        b.setButtonText('전송 철회').onClick(() =>
          this.do(async () => {
            s.policy.transfers = s.policy.transfers.filter(
              (g) => g.destination !== getDestination(config),
            );
            await p.saveSettings();
          }),
        ),
      );
  }
  private jobs(): void {
    const p = this.plugin,
      rt = p.runtime!,
      el = this.containerEl;
    new Setting(el)
      .setName('새 예약')
      .setDesc(
        '현재 자료 범위·Skill·출력 경로로 비활성 예약을 만듭니다. 시간과 다음 발생을 확인한 뒤 켜세요.',
      )
      .addButton((b) =>
        b.setButtonText('예약 추가').onClick(() =>
          this.do(async () => {
            const now = Date.now();
            rt.store.state.jobs.push({
              id: randomUUID(),
              version: 1,
              enabled: false,
              frequency: 'weekdays',
              localTime: '09:00',
              timezone: 'Asia/Seoul',
              deviceId: rt.store.state.deviceId,
              scope: [
                ...p.settings.policy.readPaths,
                ...(p.settings.githubEnabled ? p.settings.policy.githubRepos : []),
              ],
              outputPath: p.settings.dailyPath,
              skillId: rt.skill.id,
              createdAt: now,
              lastCheckedAt: now,
              missedRunPolicy: 'latest_once_within_24h',
            });
            await rt.save();
          }),
        ),
      );
    for (const job of rt.store.state.jobs) {
      const card = el.createDiv({ cls: 'harness-card' });
      card.createDiv({
        cls: 'harness-muted',
        text: `${job.id}\n범위: ${job.scope.join(', ')}\n출력: ${job.outputPath}\n기기: ${job.deviceId}`,
      });
      let next = '';
      try {
        next = new Date(nextOccurrence(job, Date.now()).scheduledFor).toLocaleString();
      } catch {
        next = '예약 설정 오류';
      }
      new Setting(card)
        .setName('예약 활성화')
        .setDesc(`다음 실행 ${next} · ${job.timezone}`)
        .addToggle((t) =>
          t.setValue(job.enabled).onChange((v) =>
            this.do(async () => {
              validateJob(job);
              job.enabled = v;
              job.version++;
              job.lastCheckedAt = Date.now();
              await rt.save();
            }),
          ),
        );
      new Setting(card).setName('반복').addDropdown((d) =>
        d
          .addOption('daily', '매일')
          .addOption('weekdays', '평일')
          .setValue(job.frequency)
          .onChange((v) =>
            this.do(async () => {
              job.frequency = v as Job['frequency'];
              job.version++;
              job.enabled = false;
              await rt.save();
            }),
          ),
      );
      let time = job.localTime,
        zone = job.timezone;
      new Setting(card)
        .setName('시각 HH:MM / 시간대')
        .addText((t) => t.setValue(time).onChange((v) => (time = v)))
        .addText((t) => t.setValue(zone).onChange((v) => (zone = v)))
        .addButton((b) =>
          b.setButtonText('변경 후 비활성 저장').onClick(() =>
            this.do(async () => {
              const changed = { ...job, localTime: time, timezone: zone };
              validateJob(changed);
              Object.assign(job, changed, { enabled: false, version: job.version + 1 });
              await rt.save();
            }),
          ),
        );
      new Setting(card)
        .setName('실행 기기')
        .addButton((b) =>
          b.setButtonText('이 기기로 지정').onClick(() =>
            this.do(async () => {
              job.deviceId = rt.store.state.deviceId;
              job.version++;
              job.enabled = false;
              await rt.save();
            }),
          ),
        )
        .addButton((b) =>
          b.setButtonText('예약 삭제').onClick(() =>
            this.do(async () => {
              rt.store.state.jobs = rt.store.state.jobs.filter((j) => j.id !== job.id);
              await rt.save();
            }),
          ),
        );
    }
  }
  private memories(): void {
    const p = this.plugin,
      rt = p.runtime!,
      el = this.containerEl;
    new Setting(el)
      .setName('기억 추가')
      .setDesc('직접 작성하고 근거 노트를 지정한 기억만 확인 상태로 저장합니다.')
      .addButton((b) =>
        b
          .setButtonText('작성')
          .onClick(() => new MemoryModal(p, undefined, () => this.display()).open()),
      );
    for (const memory of rt.store.state.memories) {
      new Setting(el)
        .setName(memory.text.slice(0, 90))
        .setDesc(
          `${memory.status} · ${memory.scope.join(', ')} · 검토 ${new Date(memory.reviewedAt).toLocaleString()}`,
        )
        .addButton((b) =>
          b
            .setButtonText('수정/확인')
            .onClick(() => new MemoryModal(p, memory, () => this.display()).open()),
        )
        .addButton((b) =>
          b.setButtonText('중지').onClick(() =>
            this.do(async () => {
              memory.status = 'inactive';
              await rt.save();
            }),
          ),
        )
        .addButton((b) =>
          b.setButtonText('삭제').onClick(() =>
            this.do(async () => {
              rt.store.state.memories = rt.store.state.memories.filter((m) => m.id !== memory.id);
              await rt.save();
              await rt.save();
            }),
          ),
        );
    }
  }
}
class ConfirmModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private body: string,
    private accept: () => void,
  ) {
    super(app);
  }
  onOpen(): void {
    this.contentEl.createEl('h3', { text: this.title });
    this.contentEl.createEl('pre', { text: this.body, cls: 'harness-diff' });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText('취소').onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText('확인하고 진행')
          .setCta()
          .onClick(() => {
            this.close();
            this.accept();
          }),
      );
  }
}
class ModelModal extends Modal {
  constructor(
    app: App,
    private models: string[],
    private choose: (model: string) => void,
  ) {
    super(app);
  }
  onOpen(): void {
    this.contentEl.createEl('h3', { text: '이 계정에서 허용된 모델' });
    for (const id of this.models)
      new Setting(this.contentEl).setName(id).addButton((b) =>
        b.setButtonText('선택').onClick(() => {
          this.choose(id);
          this.close();
        }),
      );
  }
}
class MemoryModal extends Modal {
  constructor(
    private plugin: HarnessPlugin,
    private memory: MemoryEntry | undefined,
    private done: () => void,
  ) {
    super(plugin.app);
  }
  onOpen(): void {
    this.contentEl.createEl('h3', { text: '기억 작성·확인' });
    const text = this.contentEl.createEl('textarea', { cls: 'harness-full' });
    text.value = this.memory?.text ?? '';
    let source = this.memory?.sourceRefs[0]?.path ?? '',
      scope = this.memory?.scope.join('\n') ?? '',
      expires = this.memory?.expiresAt
        ? new Date(this.memory.expiresAt).toISOString().slice(0, 10)
        : '';
    new Setting(this.contentEl)
      .setName('근거 노트 경로')
      .addText((t) => t.setValue(source).onChange((v) => (source = v)));
    new Setting(this.contentEl)
      .setName('적용 프로젝트/폴더')
      .addText((t) => t.setValue(scope).onChange((v) => (scope = v)));
    new Setting(this.contentEl)
      .setName('만료 YYYY-MM-DD (선택)')
      .addText((t) => t.setValue(expires).onChange((v) => (expires = v)));
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText('확인된 기억으로 저장')
        .setCta()
        .onClick(() =>
          this.plugin.action(async () => {
            const rt = this.plugin.requireRuntime();
            await rt.refreshIndex();
            const doc = rt.store.state.index.documents.find(
              (d) => d.kind === 'vault' && d.path === source,
            );
            if (!doc || !text.value.trim() || !lines(scope).length)
              throw new Error('INPUT: 허용된 근거 노트, 기억 내용, 적용 범위를 입력하세요.');
            const { text: _, ...ref } = doc;
            if (expires) dailyTarget('{date}', expires);
            const value: MemoryEntry = {
              id: this.memory?.id ?? randomUUID(),
              text: text.value.trim(),
              status: 'confirmed',
              scope: lines(scope),
              sourceRefs: [ref as SourceRef],
              reviewedAt: Date.now(),
              expiresAt: expires ? Date.parse(expires + 'T23:59:59+09:00') : undefined,
            };
            if (value.expiresAt !== undefined && !Number.isFinite(value.expiresAt))
              throw new Error('INPUT: 만료 날짜를 확인하세요.');
            rt.store.state.memories = rt.store.state.memories.filter((m) => m.id !== value.id);
            rt.store.state.memories.push(value);
            await rt.save();
            this.close();
            this.done();
          }),
        ),
    );
  }
}

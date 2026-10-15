import type { Policy, RunBudget } from '../../packages/contracts';
import { EMPTY_POLICY, DEFAULT_BUDGET } from '../../packages/contracts';
import type { ProviderConfig } from '../../packages/providers/types';
export interface HarnessSettings {
  version: 1;
  storageConfirmed: boolean;
  paused: boolean;
  policy: Policy;
  generation: ProviderConfig;
  embedding: ProviderConfig;
  embeddingDimensions: number;
  generationContextTokens: number;
  dailyPath: string;
  draftFolder: string;
  skillFolder: string;
  approvedSkillHash: string;
  githubBaseUrl: string;
  githubSecret: string;
  githubEnabled: boolean;
  githubMaxItems: number;
  budget: RunBudget;
  retentionDays: number;
  snapshotDays: number;
  artifactDays: number;
}
export const DEFAULT_SETTINGS: HarnessSettings = {
  version: 1,
  storageConfirmed: false,
  paused: false,
  policy: structuredClone(EMPTY_POLICY),
  generation: {
    id: 'generation',
    kind: 'openai-compatible',
    enabled: false,
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: '',
    apiKeySecret: '',
    allowPrivateHttp: false,
    structuredOutput: 'json-schema',
    timeoutMs: 60000,
  },
  embedding: {
    id: 'embedding',
    kind: 'openai-compatible',
    enabled: false,
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: '',
    apiKeySecret: '',
    allowPrivateHttp: false,
    structuredOutput: 'text',
    timeoutMs: 60000,
  },
  embeddingDimensions: 0,
  generationContextTokens: 16000,
  dailyPath: 'Daily/{date}.md',
  draftFolder: 'Harness/Drafts',
  skillFolder: '',
  approvedSkillHash: '',
  githubBaseUrl: 'https://api.github.com',
  githubSecret: 'harness-github',
  githubEnabled: false,
  githubMaxItems: 1000,
  budget: { ...DEFAULT_BUDGET },
  retentionDays: 90,
  snapshotDays: 7,
  artifactDays: 7,
};
export function loadSettings(value: unknown): HarnessSettings {
  const d = structuredClone(DEFAULT_SETTINGS);
  if (!value || typeof value !== 'object') return d;
  const v = value as Partial<HarnessSettings>;
  return {
    ...d,
    ...v,
    policy: { ...d.policy, ...v.policy },
    generation: { ...d.generation, ...v.generation },
    embedding: { ...d.embedding, ...v.embedding },
    budget: { ...d.budget, ...v.budget },
  };
}
export function dailyTarget(pattern: string, date: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(Date.parse(date + 'T00:00:00Z')) ||
    new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date
  )
    throw new Error('DATE: 유효한 YYYY-MM-DD 날짜를 입력하세요.');
  return pattern
    .replaceAll('{date}', date)
    .replaceAll('{YYYY}', date.slice(0, 4))
    .replaceAll('{MM}', date.slice(5, 7))
    .replaceAll('{DD}', date.slice(8, 10));
}
export function today(): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

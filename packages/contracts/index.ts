export type SourceKind = 'vault' | 'github';
export interface SourceRef {
  id: string;
  kind: SourceKind;
  uri: string;
  path: string;
  title: string;
  hash: string;
  updatedAt: number;
  indexedAt: number;
  locator?: string;
}
export interface SourceDocument extends SourceRef {
  text: string;
  project: string;
  tags: string[];
}
export interface Evidence extends SourceRef {
  text: string;
  project: string;
  tags: string[];
  score: number;
  vector?: number[];
  embeddingKey?: string;
}
export interface TransferGrant {
  destination: string;
  paths: string[];
  githubRepos: string[];
  allowUserInput: boolean;
}
export interface Policy {
  version: number;
  readPaths: string[];
  excludedPaths: string[];
  writePaths: string[];
  githubRepos: string[];
  transfers: TransferGrant[];
  operationalPaths: string[];
}
export interface RunBudget {
  maxModelCalls: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  activeTimeoutMs: number;
  requestTimeoutMs: number;
}
export type RunState =
  | 'QUEUED'
  | 'PREPARING'
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'APPLYING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'BLOCKED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'CANCELED'
  | 'INTERRUPTED';
export interface Run {
  id: string;
  trigger: 'manual' | 'scheduled' | 'retry';
  state: RunState;
  mode?: 'answer' | 'daily' | 'draft';
  createdAt: number;
  updatedAt: number;
  policyVersion: number;
  skillId: string;
  skillVersion: string;
  manifestHash: string;
  date: string;
  query: string;
  scope: string[];
  parentRunId?: string;
  jobId?: string;
  occurrenceKey?: string;
  scheduledFor?: string;
  stage: string;
  errorCode?: string;
  message?: string;
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cost: '가격 미설정';
  evidence: SourceRef[];
  answer?: string;
  changeSetId?: string;
}
export interface ChangeSet {
  id: string;
  runId: string;
  targetUri: string;
  baseHash: string;
  patchHash: string;
  expectedHash: string;
  outputKey: string;
  sourceRefs: SourceRef[];
  policyVersion: number;
  before: string | null;
  after: string;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'applied' | 'rejected' | 'expired' | 'blocked';
  kind: 'daily-section' | 'new-draft' | 'rollback';
  approvedHash?: string;
  appliedAt?: number;
  rollbackOf?: string;
}
export interface ApplyIntent {
  changeSetId: string;
  targetUri: string;
  baseHash: string;
  expectedHash: string;
  state: 'prepared' | 'applied' | 'blocked';
  createdAt: number;
}
export interface MemoryEntry {
  id: string;
  text: string;
  status: 'candidate' | 'confirmed' | 'inactive' | 'expired';
  scope: string[];
  sourceRefs: SourceRef[];
  reviewedAt: number;
  expiresAt?: number;
}
export interface Skill {
  id: string;
  version: string;
  manifestHash: string;
  instructions: string;
  requiredTools: string[];
  optionalTools: string[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}
export interface SearchFilter {
  paths?: string[];
  githubRepos?: string[];
  project?: string;
  tags?: string[];
  kind?: SourceKind;
  from?: number;
  to?: number;
}
export interface SearchResult {
  evidence: Evidence[];
  mode: 'hybrid' | 'keyword-only';
  reason?: string;
}
export interface Job {
  id: string;
  version: number;
  enabled: boolean;
  frequency: 'daily' | 'weekdays';
  localTime: string;
  timezone: string;
  deviceId: string;
  scope: string[];
  outputPath: string;
  skillId: string;
  createdAt: number;
  lastCheckedAt: number;
  missedRunPolicy: 'latest_once_within_24h';
}
export interface Occurrence {
  key: string;
  jobId: string;
  scheduledFor: string;
  date: string;
  state: 'queued' | 'skipped';
  reason?: string;
}
export interface IndexState {
  documents: SourceDocument[];
  chunks: Evidence[];
  embeddingKey?: string;
  processed: number;
  pending: number;
  failed: number;
  lastSuccessAt?: number;
  paused: boolean;
}
export interface GithubSyncState {
  repo: string;
  cursor?: string;
  lastSuccessAt?: number;
  status: 'idle' | 'syncing' | 'success' | 'partial' | 'blocked' | 'failed';
  message?: string;
  documents: SourceDocument[];
}
export interface AuditEvent {
  at: number;
  runId?: string;
  action: string;
  code?: string;
  ref?: string;
}
export interface HarnessState {
  schemaVersion: 1;
  deviceId: string;
  runs: Run[];
  changes: ChangeSet[];
  intents: ApplyIntent[];
  memories: MemoryEntry[];
  jobs: Job[];
  occurrences: Occurrence[];
  index: IndexState;
  github: GithubSyncState[];
  audit: AuditEvent[];
}
export interface StateStore {
  state: HarnessState;
  save(): Promise<void>;
  readonly readOnly: boolean;
}
export interface VaultPort {
  list(): Promise<SourceDocument[]>;
  read(path: string): Promise<string | null>;
  apply(path: string, baseHash: string, after: string): Promise<void>;
  isOpen(path: string): boolean;
}
export interface ReviewItem {
  text: string;
  sources: string[];
}
export interface DailyReview {
  projects: {
    name: string;
    activity: ReviewItem[];
    openItems: ReviewItem[];
    suggestedNextActions: ReviewItem[];
    uncertainties: ReviewItem[];
    sources: string[];
  }[];
}
export const DEFAULT_BUDGET: RunBudget = {
  maxModelCalls: 6,
  maxToolCalls: 20,
  maxInputTokens: 16000,
  maxOutputTokens: 3000,
  activeTimeoutMs: 120000,
  requestTimeoutMs: 60000,
};
export const EMPTY_POLICY: Policy = {
  version: 1,
  readPaths: [],
  excludedPaths: [],
  writePaths: [],
  githubRepos: [],
  transfers: [],
  operationalPaths: ['Harness'],
};

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type ProviderKind = 'openai-compatible' | 'ollama' | 'chatgpt';
export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  enabled: boolean;
  /** OpenAI compatible: API base ending /v1; Ollama: server origin. */
  baseUrl: string;
  model: string;
  apiKeySecret?: string;
  allowPrivateHttp?: boolean;
  structuredOutput: 'json-schema' | 'json-object' | 'text';
  timeoutMs?: number;
}
export interface GenerationRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  maxOutputTokens?: number;
  jsonSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}
export interface GenerationResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
  finishReason: string;
}
export interface GenerationProvider {
  readonly id: string;
  readonly target: 'local' | 'external';
  generate(request: GenerationRequest): Promise<GenerationResult>;
}
export interface EmbeddingProvider {
  readonly id: string;
  readonly target: 'local' | 'external';
  readonly model: string;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}
export type ProviderErrorCode =
  | 'DISABLED'
  | 'CONFIGURATION'
  | 'ENDPOINT_BLOCKED'
  | 'AUTH_REQUIRED'
  | 'AUTH_INVALID'
  | 'ACCESS_DENIED'
  | 'RATE_LIMITED'
  | 'UNSUPPORTED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'NETWORK'
  | 'SERVER'
  | 'INVALID_RESPONSE'
  | 'OUTPUT_LIMIT';
export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly retryAfterMs = 0,
    public outputTokens?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
/** Provider errors never contain remote bodies, URLs, headers, tokens or prompts. */
export function safeProviderError(error: unknown): string {
  return error instanceof ProviderError
    ? `${error.code}: ${error.message}`
    : 'PROVIDER_ERROR: 모델 요청이 실패했습니다. 설정과 연결을 확인하세요.';
}
export function cancelled(): ProviderError {
  return new ProviderError('CANCELLED', '요청을 중단했습니다.');
}
export const DEFAULT_GENERATION: ProviderConfig = {
  id: 'generation',
  kind: 'ollama',
  enabled: false,
  baseUrl: 'http://127.0.0.1:11434',
  model: '',
  structuredOutput: 'json-schema',
  timeoutMs: 60000,
};
export const DEFAULT_EMBEDDING: ProviderConfig = {
  ...DEFAULT_GENERATION,
  id: 'embedding',
  model: '',
};

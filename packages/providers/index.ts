import { ChatGPTAuth } from './chatgpt-auth';
import {
  assertHttpSuccess,
  boundedHttp,
  endpoint,
  getTarget,
  parseJson,
  type HttpTransport,
} from './http';
import {
  cancelled,
  ProviderError,
  type EmbeddingProvider,
  type GenerationProvider,
  type GenerationRequest,
  type GenerationResult,
  type ProviderConfig,
  type SecretStore,
} from './types';
export * from './types';
export * from './chatgpt-auth';
export { getDestination, getTarget, normalizedBase } from './http';

function validateConfig(config: ProviderConfig): void {
  if (!config.enabled)
    throw new ProviderError('DISABLED', '모델 연결이 꺼져 있습니다. 설정에서 활성화하세요.');
  if (
    !config.model.trim() ||
    config.model.length > 200 ||
    !config.id ||
    !['ollama', 'openai-compatible', 'chatgpt'].includes(config.kind)
  )
    throw new ProviderError('CONFIGURATION', '제공자와 모델 이름을 설정하세요.');
  if (!['json-schema', 'json-object', 'text'].includes(config.structuredOutput))
    throw new ProviderError('CONFIGURATION', '구조화 출력 지원 방식을 설정하세요.');
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function usage(input: unknown, output: unknown): GenerationResult['usage'] {
  const inputTokens = integer(input);
  const outputTokens = integer(output);
  return inputTokens !== undefined && outputTokens !== undefined
    ? { inputTokens, outputTokens }
    : undefined;
}
function invalidResponse(): never {
  throw new ProviderError(
    'INVALID_RESPONSE',
    '완전한 텍스트 응답을 받지 못했습니다. 모델과 출력 지원 설정을 확인하세요.',
  );
}
async function headers(
  config: ProviderConfig,
  secrets: SecretStore,
): Promise<Record<string, string>> {
  if (!config.apiKeySecret) return { 'content-type': 'application/json' };
  const key = await secrets.get(config.apiKeySecret);
  if (!key)
    throw new ProviderError(
      'AUTH_REQUIRED',
      '설정한 비밀값을 찾을 수 없습니다. 비밀값 저장소에 API 키를 추가하세요.',
    );
  if (/[\r\n]/.test(key)) throw new ProviderError('AUTH_INVALID', 'API 키 형식이 잘못되었습니다.');
  return { 'content-type': 'application/json', authorization: `Bearer ${key}` };
}
function prepareMessages(request: GenerationRequest): GenerationRequest['messages'] {
  if (
    !Array.isArray(request.messages) ||
    !request.messages.length ||
    request.messages.length > 100 ||
    request.messages.some(
      (m) => !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string',
    )
  )
    throw new ProviderError('CONFIGURATION', '모델 입력 형식이 잘못되었습니다.');
  if (!request.jsonSchema) return request.messages.map((m) => ({ ...m }));
  const contract = `Return only a JSON object matching this schema. Do not include markdown fences. Schema: ${JSON.stringify(request.jsonSchema)}`;
  return [{ role: 'system', content: contract }, ...request.messages];
}
function outputLimit(request: GenerationRequest): number {
  const limit = request.maxOutputTokens ?? 4096;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 65536)
    throw new ProviderError('CONFIGURATION', '출력 토큰 한도를 1–65536으로 설정하세요.');
  return limit;
}
function validateOutput(result: GenerationResult, request: GenerationRequest): GenerationResult {
  try {
    if (!result.text.trim()) invalidResponse();
    if (result.text.length > outputLimit(request) * 16)
      throw new ProviderError('OUTPUT_LIMIT', '출력 크기 한도를 초과했습니다.');
    if (result.usage && result.usage.outputTokens > outputLimit(request))
      throw new ProviderError('OUTPUT_LIMIT', '모델이 요청한 출력 토큰 한도를 초과했습니다.');
    if (request.jsonSchema) {
      try {
        const parsed: unknown = JSON.parse(result.text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw 0;
      } catch {
        throw new ProviderError(
          'INVALID_RESPONSE',
          '모델이 JSON 객체를 반환하지 않았습니다. 구조화 출력 지원을 확인하세요.',
        );
      }
    }
    return result;
  } catch (error) {
    // A rejected JSON result still consumed output; let Core charge it before correction.
    if (error instanceof ProviderError)
      error.outputTokens = Math.max(
        result.usage?.outputTokens ?? 0,
        Buffer.byteLength(result.text, 'utf8'),
      );
    throw error;
  }
}

/** No tools, functions, shells, or fallback providers are exposed to any model. */
export function createGenerationProvider(
  config: ProviderConfig,
  secrets: SecretStore,
  chatGPTAuth?: ChatGPTAuth,
  transport: HttpTransport = boundedHttp,
): GenerationProvider {
  const snapshot = { ...config };
  return {
    id: snapshot.id,
    target: getTarget(snapshot),
    async generate(request) {
      validateConfig(snapshot);
      if (request.signal?.aborted) throw cancelled();
      const messages = prepareMessages(request);
      const maxTokens = outputLimit(request);
      if (snapshot.kind === 'chatgpt') {
        if (!chatGPTAuth) throw new ProviderError('AUTH_REQUIRED', 'ChatGPT 로그인을 설정하세요.');
        const body: Record<string, unknown> = {
          model: snapshot.model,
          store: false,
          stream: true,
          instructions: messages
            .filter((m) => m.role === 'system')
            .map((m) => m.content)
            .join('\n\n'),
          input: messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({ role: m.role, content: m.content })),
        };
        if (request.jsonSchema && snapshot.structuredOutput === 'json-schema')
          body.text = {
            format: {
              type: 'json_schema',
              name: 'harness_output',
              strict: true,
              schema: request.jsonSchema,
            },
          };
        else if (request.jsonSchema && snapshot.structuredOutput === 'json-object')
          body.text = { format: { type: 'json_object' } };
        // SIWC preview rejects max_output_tokens. Enforce local byte/time bounds and reject over-budget results.
        const result = await chatGPTAuth.request('responses', {
          method: 'POST',
          body: JSON.stringify(body),
          signal: request.signal,
          timeoutMs: snapshot.timeoutMs,
          maxBytes: Math.min(8 * 1024 * 1024, maxTokens * 128 + 65536),
        });
        assertHttpSuccess(result);
        return validateOutput(parseResponsesStream(result.body), request);
      }
      const body: Record<string, unknown> = { model: snapshot.model, messages, stream: false };
      if (snapshot.kind === 'ollama') {
        body.options = { num_predict: maxTokens };
        if (request.jsonSchema && snapshot.structuredOutput !== 'text')
          body.format = snapshot.structuredOutput === 'json-schema' ? request.jsonSchema : 'json';
      } else {
        body.max_tokens = maxTokens;
        if (request.jsonSchema && snapshot.structuredOutput === 'json-schema')
          body.response_format = {
            type: 'json_schema',
            json_schema: { name: 'harness_output', strict: true, schema: request.jsonSchema },
          };
        else if (request.jsonSchema && snapshot.structuredOutput === 'json-object')
          body.response_format = { type: 'json_object' };
      }
      const requestHeaders = await headers(snapshot, secrets);
      if (request.signal?.aborted) throw cancelled();
      const data = parseJson(
        await transport({
          url: endpoint(snapshot, snapshot.kind === 'ollama' ? 'api/chat' : 'chat/completions'),
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify(body),
          signal: request.signal,
          timeoutMs: snapshot.timeoutMs,
          allowPrivateHttp: snapshot.allowPrivateHttp,
        }),
      );
      if (snapshot.kind === 'ollama') {
        const message = object(data.message);
        if (
          data.done !== true ||
          data.done_reason === 'length' ||
          (Array.isArray(message.tool_calls) && message.tool_calls.length) ||
          typeof message.content !== 'string'
        )
          invalidResponse();
        return validateOutput(
          {
            text: message.content,
            finishReason: typeof data.done_reason === 'string' ? data.done_reason : 'stop',
            usage: usage(data.prompt_eval_count, data.eval_count),
          },
          request,
        );
      }
      const choice = Array.isArray(data.choices) ? object(data.choices[0]) : {};
      const message = object(choice.message);
      const counts = object(data.usage);
      if (
        choice.finish_reason !== 'stop' ||
        (Array.isArray(message.tool_calls) && message.tool_calls.length) ||
        message.function_call ||
        typeof message.content !== 'string'
      )
        invalidResponse();
      return validateOutput(
        {
          text: message.content,
          finishReason: 'stop',
          usage: usage(counts.prompt_tokens, counts.completion_tokens),
        },
        request,
      );
    },
  };
}
/** Completion is required; text deltas alone never count as success. */
export function parseResponsesStream(body: string): GenerationResult {
  let text = '';
  let completed = false;
  let counts: GenerationResult['usage'];
  for (const block of body.replace(/\r\n/g, '\n').split('\n\n')) {
    const dataLines = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (!dataLines.length) continue;
    const raw = dataLines.join('\n');
    if (raw === '[DONE]') continue;
    let event: Record<string, unknown>;
    try {
      event = object(JSON.parse(raw));
    } catch {
      invalidResponse();
    }
    if (event.type === 'response.output_text.delta') {
      if (completed || typeof event.delta !== 'string') invalidResponse();
      text += event.delta;
    } else if (['response.failed', 'response.incomplete', 'error'].includes(String(event.type))) {
      const code =
        object(object(event.response).error).code ?? object(event.error).code ?? event.code;
      if (
        code === 'subscription_sharing_usage_limit_exceeded' ||
        code === 'subscription_sharing_usage_unavailable'
      )
        throw new ProviderError('RATE_LIMITED', 'ChatGPT 요금제 사용 한도를 확인하세요.');
      invalidResponse();
    } else if (event.type === 'response.completed') {
      if (completed) invalidResponse();
      const response = object(event.response);
      if (response.status !== 'completed' || !Array.isArray(response.output)) invalidResponse();
      // Reject unexpected tool calls and refusals even if a text delta was also emitted.
      for (const value of response.output) {
        const item = object(value);
        if (item.type !== 'message' && item.type !== 'reasoning') invalidResponse();
        if (
          item.type === 'message' &&
          Array.isArray(item.content) &&
          item.content.some((part) => object(part).type !== 'output_text')
        )
          invalidResponse();
      }
      if (!text)
        text = response.output
          .flatMap((value) => {
            const item = object(value);
            return item.type === 'message' && Array.isArray(item.content)
              ? item.content
                  .map((part) => object(part).text)
                  .filter((s): s is string => typeof s === 'string')
              : [];
          })
          .join('');
      const reported = object(response.usage);
      counts = usage(reported.input_tokens, reported.output_tokens);
      completed = true;
    }
  }
  if (!completed || !text.trim()) invalidResponse();
  return { text, finishReason: 'stop', usage: counts };
}
export function createEmbeddingProvider(
  config: ProviderConfig,
  secrets: SecretStore,
  transport: HttpTransport = boundedHttp,
): EmbeddingProvider {
  const snapshot = { ...config };
  return {
    id: snapshot.id,
    target: getTarget(snapshot),
    model: snapshot.model,
    async embed(texts, signal) {
      validateConfig(snapshot);
      if (signal?.aborted) throw cancelled();
      if (snapshot.kind === 'chatgpt')
        throw new ProviderError(
          'UNSUPPORTED',
          'ChatGPT 로그인은 임베딩 API를 지원하지 않습니다. Ollama 또는 사내 임베딩 모델을 설정하세요.',
        );
      if (!texts.length) return [];
      if (texts.length > 128 || texts.some((s) => typeof s !== 'string' || s.length > 100000))
        throw new ProviderError('CONFIGURATION', '임베딩 입력 배치 또는 문서 크기를 줄이세요.');
      const body = {
        model: snapshot.model,
        input: texts,
        ...(snapshot.kind === 'ollama' ? { truncate: false } : {}),
      };
      const requestHeaders = await headers(snapshot, secrets);
      if (signal?.aborted) throw cancelled();
      const data = parseJson(
        await transport({
          url: endpoint(snapshot, snapshot.kind === 'ollama' ? 'api/embed' : 'embeddings'),
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify(body),
          signal,
          timeoutMs: snapshot.timeoutMs,
          allowPrivateHttp: snapshot.allowPrivateHttp,
        }),
      );
      let vectors: unknown = data.embeddings;
      if (snapshot.kind === 'openai-compatible') {
        if (!Array.isArray(data.data) || data.data.length !== texts.length) invalidResponse();
        const rows = data.data.map(object);
        if (
          rows.some(
            (r) =>
              !Number.isSafeInteger(r.index) ||
              Number(r.index) < 0 ||
              Number(r.index) >= texts.length,
          ) ||
          new Set(rows.map((r) => r.index)).size !== texts.length
        )
          invalidResponse();
        vectors = rows.sort((a, b) => Number(a.index) - Number(b.index)).map((r) => r.embedding);
      }
      if (!Array.isArray(vectors) || vectors.length !== texts.length) invalidResponse();
      let dimensions = 0;
      for (const row of vectors) {
        if (
          !Array.isArray(row) ||
          row.length === 0 ||
          row.length > 65536 ||
          row.some((n) => typeof n !== 'number' || !Number.isFinite(n))
        )
          invalidResponse();
        if (dimensions && row.length !== dimensions) invalidResponse();
        dimensions = row.length;
      }
      return vectors as number[][];
    },
  };
}
/** Explicit connection test only: no Vault contents and no automatic fallback requests. */
export async function testGeneration(
  provider: GenerationProvider,
  signal?: AbortSignal,
): Promise<void> {
  const result = await provider.generate({
    messages: [{ role: 'user', content: 'Connection test only. Return {"ok":true}.' }],
    jsonSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean', enum: [true] } },
      required: ['ok'],
      additionalProperties: false,
    },
    maxOutputTokens: 128,
    signal,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    invalidResponse();
  }
  const data = object(parsed);
  if (data.ok !== true || Object.keys(data).length !== 1)
    throw new ProviderError(
      'INVALID_RESPONSE',
      '모델이 연결 시험의 구조화 출력 계약을 지키지 않았습니다.',
    );
}

import { createServer, get, type Server, type RequestListener } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChatGPTAuth,
  createEmbeddingProvider,
  createGenerationProvider,
  DEFAULT_GENERATION,
  getDestination,
  getTarget,
  parseResponsesStream,
  ProviderError,
  safeProviderError,
  testGeneration,
  type ProviderConfig,
  type SecretStore,
} from '../packages/providers';
import {
  boundedHttp,
  assertHttpSuccess,
  retryAfterMs,
  type HttpInput,
  type HttpTransport,
} from '../packages/providers/http';

function memorySecrets(): SecretStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
  };
}
const config: ProviderConfig = { ...DEFAULT_GENERATION, enabled: true, model: 'test-model' };
const schema = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
};
const request = {
  messages: [{ role: 'user' as const, content: 'Synthetic test fixture' }],
  jsonSchema: schema,
};
const chatResult = JSON.stringify({
  choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
  usage: { prompt_tokens: 8, completion_tokens: 6 },
});
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
async function server(handler: RequestListener): Promise<string> {
  const value = createServer(handler);
  servers.push(value);
  await new Promise<void>((resolve) => value.listen(0, '127.0.0.1', resolve));
  const address = value.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  return `http://127.0.0.1:${address.port}`;
}
function callback(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    }).on('error', reject);
  });
}
describe('provider transport and policy boundaries', () => {
  it('keeps both providers disabled by default', async () => {
    const transport = vi.fn();
    await expect(
      createGenerationProvider(DEFAULT_GENERATION, memorySecrets(), undefined, transport).generate(
        request,
      ),
    ).rejects.toMatchObject({ code: 'DISABLED' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('binds transfer approval to the normalized endpoint and model', () => {
    expect(getDestination(config)).toBe(
      getDestination({ ...config, baseUrl: 'http://127.0.0.1:11434/' }),
    );
    expect(getDestination(config)).not.toBe(
      getDestination({ ...config, baseUrl: 'http://127.0.0.1:9999' }),
    );
    expect(getDestination(config)).not.toBe(getDestination({ ...config, model: 'other' }));
    expect(getTarget(config)).toBe('local');
    expect(getTarget({ ...config, baseUrl: 'http://10.0.0.2', allowPrivateHttp: true })).toBe(
      'external',
    );
    expect(getTarget({ ...config, kind: 'chatgpt' })).toBe('external');
  });
  it.each([
    'file:///tmp/model',
    'http://user:password@localhost:11434',
    'http://localhost:11434/?token=secret',
    'http://localhost:11434/#fragment',
    'http://10.1.2.3',
  ])('rejects unsafe configured endpoint %s', (baseUrl) => {
    expect(() => getDestination({ ...config, baseUrl })).toThrow(ProviderError);
  });
  it('permits loopback requests without corporate HTTP override', async () => {
    const base = await server((_req, res) => res.end('{"ok":true}'));
    expect(await boundedHttp({ url: base })).toMatchObject({ status: 200, body: '{"ok":true}' });
  });
  it('denies redirects and never calls their destination', async () => {
    const destination = vi.fn<RequestListener>((_req, res) => {
      res.end('secret');
    });
    const target = await server(destination);
    const origin = await server((_req, res) => {
      res.writeHead(302, { location: target });
      res.end();
    });
    await expect(boundedHttp({ url: origin })).rejects.toMatchObject({ code: 'ENDPOINT_BLOCKED' });
    expect(destination).not.toHaveBeenCalled();
  });
  it('denies public HTTP even when corporate HTTP is allowed', async () => {
    await expect(
      boundedHttp({ url: 'http://8.8.8.8', allowPrivateHttp: true }),
    ).rejects.toMatchObject({ code: 'ENDPOINT_BLOCKED' });
  });
  it('aborts an in-flight connection', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const base = await server((_req, _res) => markStarted());
    const controller = new AbortController();
    const operation = boundedHttp({ url: base, signal: controller.signal });
    await started;
    controller.abort();
    await expect(operation).rejects.toMatchObject({ code: 'CANCELLED' });
  });
  it('bounds response size and request duration', async () => {
    const large = await server((_req, res) => res.end('x'.repeat(100)));
    await expect(boundedHttp({ url: large, maxBytes: 10 })).rejects.toMatchObject({
      code: 'OUTPUT_LIMIT',
    });
    const idle = await server((_req, _res) => {});
    await expect(boundedHttp({ url: idle, timeoutMs: 100 })).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });
});
describe('generation and embedding adapters', () => {
  it('sends Ollama native schema without tools and reports usage', async () => {
    const transport = vi.fn<HttpTransport>(async () => ({
      status: 200,
      body: JSON.stringify({
        done: true,
        done_reason: 'stop',
        message: { content: '{"ok":true}' },
        prompt_eval_count: 9,
        eval_count: 6,
      }),
    }));
    const result = await createGenerationProvider(
      config,
      memorySecrets(),
      undefined,
      transport,
    ).generate(request);
    const input = transport.mock.calls[0][0];
    const body = JSON.parse(input.body!);
    expect(input.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(body).toMatchObject({ format: schema, options: { num_predict: 4096 }, stream: false });
    expect(body).not.toHaveProperty('tools');
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 6 });
  });
  it('uses only the named secret and exact configured chat/completions path', async () => {
    const secrets = memorySecrets();
    await secrets.set('company-key', 'synthetic-key');
    const transport = vi.fn<HttpTransport>(async () => ({ status: 200, body: chatResult }));
    const provider = createGenerationProvider(
      {
        ...config,
        kind: 'openai-compatible',
        baseUrl: 'https://ai.example.test/proxy/v1',
        apiKeySecret: 'company-key',
      },
      secrets,
      undefined,
      transport,
    );
    await testGeneration(provider);
    const input = transport.mock.calls[0][0];
    const body = JSON.parse(input.body!);
    expect(input.url).toBe('https://ai.example.test/proxy/v1/chat/completions');
    expect(input.headers?.authorization).toBe('Bearer synthetic-key');
    expect(body.response_format.type).toBe('json_schema');
    expect(body).not.toHaveProperty('tools');
  });
  it('does not retry or leak remote error content', async () => {
    const transport = vi.fn<HttpTransport>(async () => ({
      status: 401,
      body: 'Authorization: Bearer SECRET fixture-user-note',
    }));
    try {
      await createGenerationProvider(config, memorySecrets(), undefined, transport).generate(
        request,
      );
      throw new Error('expected failure');
    } catch (error) {
      expect(safeProviderError(error)).not.toContain('SECRET');
      expect(safeProviderError(error)).not.toContain('fixture-user-note');
      expect(error).toMatchObject({ code: 'AUTH_INVALID' });
    }
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('blocks missing API key before sending any data', async () => {
    const transport = vi.fn();
    await expect(
      createGenerationProvider(
        { ...config, apiKeySecret: 'missing' },
        memorySecrets(),
        undefined,
        transport,
      ).generate(request),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([
    { choices: [{ finish_reason: 'length', message: { content: '{}' } }] },
    {
      choices: [
        { finish_reason: 'stop', message: { content: '{}', tool_calls: [{ name: 'shell' }] } },
      ],
    },
    { choices: [{ finish_reason: 'stop', message: { content: 'not JSON' } }] },
  ])('rejects truncated, tool-call or invalid JSON output', async (response) => {
    const transport: HttpTransport = async () => ({ status: 200, body: JSON.stringify(response) });
    await expect(
      createGenerationProvider(
        { ...config, kind: 'openai-compatible' },
        memorySecrets(),
        undefined,
        transport,
      ).generate(request),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('charges rejected JSON by its byte lower bound when a server reports zero usage', async () => {
    const badText = '한'.repeat(200);
    const transport: HttpTransport = async () => ({
      status: 200,
      body: JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: badText } }],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      }),
    });
    const provider = createGenerationProvider(
      { ...config, kind: 'openai-compatible' },
      memorySecrets(),
      undefined,
      transport,
    );
    try {
      await provider.generate(request);
      throw new Error('Expected malformed JSON rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ code: 'INVALID_RESPONSE' });
      expect((error as ProviderError).outputTokens).toBeGreaterThanOrEqual(
        Buffer.byteLength(badText, 'utf8'),
      );
    }
  });
  it('validates actual connection test contract', async () => {
    const transport: HttpTransport = async () => ({
      status: 200,
      body: chatResult.replace('true', 'false'),
    });
    await expect(
      testGeneration(
        createGenerationProvider(
          { ...config, kind: 'openai-compatible' },
          memorySecrets(),
          undefined,
          transport,
        ),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('returns OpenAI-compatible embeddings in original input order', async () => {
    const transport = vi.fn<HttpTransport>(async () => ({
      status: 200,
      body: JSON.stringify({
        data: [
          { index: 1, embedding: [3, 4] },
          { index: 0, embedding: [1, 2] },
        ],
      }),
    }));
    const result = await createEmbeddingProvider(
      { ...config, kind: 'openai-compatible', baseUrl: 'https://company.example/v1' },
      memorySecrets(),
      transport,
    ).embed(['a', 'b']);
    expect(result).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(transport.mock.calls[0][0].url).toBe('https://company.example/v1/embeddings');
  });
  it('uses Ollama embed without silent truncation', async () => {
    const transport = vi.fn<HttpTransport>(async () => ({
      status: 200,
      body: JSON.stringify({ embeddings: [[0.1, 0.2]] }),
    }));
    await createEmbeddingProvider(config, memorySecrets(), transport).embed(['Synthetic fixture']);
    expect(transport.mock.calls[0][0].url).toBe('http://127.0.0.1:11434/api/embed');
    expect(JSON.parse(transport.mock.calls[0][0].body!)).toMatchObject({ truncate: false });
  });
  it.each([{ embeddings: [[1], [2, 3]] }, { embeddings: [[1], [null]] }, { embeddings: [] }])(
    'rejects malformed embedding vectors',
    async ({ embeddings }) => {
      const transport: HttpTransport = async () => ({
        status: 200,
        body: JSON.stringify({ embeddings }),
      });
      await expect(
        createEmbeddingProvider(config, memorySecrets(), transport).embed(['a', 'b']),
      ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    },
  );
  it('does not claim ChatGPT plan supports embeddings', async () => {
    await expect(
      createEmbeddingProvider({ ...config, kind: 'chatgpt' }, memorySecrets()).embed(['test']),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });
});
function sse(type: string, values: Record<string, unknown>) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...values })}\n\n`;
}
const completed = () =>
  sse('response.completed', {
    response: {
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
      usage: { input_tokens: 2, output_tokens: 6 },
    },
  });
describe('ChatGPT Responses SSE', () => {
  it('requires a completed event and handles chunk text', () => {
    expect(
      parseResponsesStream(
        sse('response.output_text.delta', { delta: '{"ok":true}' }) + completed(),
      ),
    ).toMatchObject({ text: '{"ok":true}', usage: { inputTokens: 2, outputTokens: 6 } });
    expect(() =>
      parseResponsesStream(sse('response.output_text.delta', { delta: 'partial' })),
    ).toThrow(ProviderError);
  });
  it('rejects post-delta plan usage failure', () => {
    expect(() =>
      parseResponsesStream(
        sse('response.output_text.delta', { delta: 'partial' }) +
          sse('response.failed', {
            response: {
              error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'SENSITIVE' },
            },
          }),
      ),
    ).toThrow(/RATE|한도/);
  });
  it('rejects incomplete output and unexpected tool calls', () => {
    expect(() => parseResponsesStream(sse('response.incomplete', {}))).toThrow(ProviderError);
    expect(() =>
      parseResponsesStream(
        sse('response.completed', {
          response: { status: 'completed', output: [{ type: 'function_call', name: 'shell' }] },
        }),
      ),
    ).toThrow(ProviderError);
  });
});

async function oauthFixture(
  options: {
    invalidNonce?: boolean;
    invalidAudience?: boolean;
    invalidIssuer?: boolean;
    invalidSignature?: boolean;
    expiredIdentity?: boolean;
    refusePlan?: boolean;
    expired?: boolean;
    failRevoke?: boolean;
  } = {},
) {
  const keys = await generateKeyPair('RS256', { extractable: true });
  const wrongKeys = options.invalidSignature ? await generateKeyPair('RS256') : keys;
  const publicJwk = await exportJWK(keys.publicKey);
  publicJwk.kid = 'fixture';
  const secrets = memorySecrets();
  let authorizeUrl = new URL('https://auth.openai.com');
  let refreshCount = 0;
  const clientId = 'oaiapp_fixture';
  const transport = vi.fn<HttpTransport>(async (input) => {
    if (input.url.endsWith('/oauth/token')) {
      const form = new URLSearchParams(input.body);
      const refresh = form.get('grant_type') === 'refresh_token';
      if (refresh) refreshCount++;
      const idToken = await new SignJWT({
        nonce: options.invalidNonce ? 'wrong' : authorizeUrl.searchParams.get('nonce'),
        email: 'fixture@example.test',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
        .setIssuer(options.invalidIssuer ? 'https://wrong.example' : 'https://auth.openai.com')
        .setSubject('fixture-subject')
        .setAudience(options.invalidAudience ? 'wrong-client' : clientId)
        .setIssuedAt()
        .setExpirationTime(options.expiredIdentity ? Math.floor(Date.now() / 1000) - 60 : '5m')
        .sign(wrongKeys.privateKey);
      return {
        status: 200,
        body: JSON.stringify({
          id_token: idToken,
          access_token: refresh ? 'fixture-access-renewed' : 'fixture-access',
          refresh_token: refresh ? 'fixture-refresh-renewed' : 'fixture-refresh',
          token_type: 'Bearer',
          expires_in: options.expired && !refresh ? 1 : 3600,
          scope: options.refusePlan
            ? 'openid profile email'
            : 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
        }),
      };
    }
    if (input.url.endsWith('/jwks.json'))
      return { status: 200, body: JSON.stringify({ keys: [publicJwk] }) };
    if (input.url.endsWith('/openid-configuration'))
      return {
        status: 200,
        body: JSON.stringify({
          issuer: 'https://auth.openai.com',
          revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke',
        }),
      };
    if (input.url.endsWith('/oauth/revoke'))
      return { status: options.failRevoke ? 503 : 200, body: '' };
    if (input.url.endsWith('/models'))
      return {
        status: 200,
        body: JSON.stringify({
          models: [
            { visibility: 'list', slug: 'fixture-model', display_name: 'Fixture Model' },
            { visibility: 'hidden', slug: 'hidden', display_name: 'Hidden' },
          ],
        }),
      };
    if (input.url.endsWith('/responses')) return { status: 200, body: completed() };
    throw new Error('Unexpected synthetic request');
  });
  const auth = new ChatGPTAuth(secrets, 'd5cd4a2e-58ee-49ef-9f71-c6033547aa6b', transport);
  const open = async (value: string) => {
    authorizeUrl = new URL(value);
    const callbackUrl = new URL(authorizeUrl.searchParams.get('redirect_uri')!);
    callbackUrl.search = new URLSearchParams({
      code: 'fixture-code',
      state: authorizeUrl.searchParams.get('state')!,
      client_id: clientId,
    }).toString();
    expect(await callback(callbackUrl.href)).toBe(200);
  };
  return {
    auth,
    secrets,
    transport,
    open,
    getAuthorizeUrl: () => authorizeUrl,
    refreshCount: () => refreshCount,
  };
}
describe('ChatGPT login with synthetic OAuth server responses', () => {
  it('uses dynamic registration, PKCE, nonce validation, separate storage and live models', async () => {
    const f = await oauthFixture();
    const account = await f.auth.signIn(f.open);
    const authUrl = f.getAuthorizeUrl();
    expect(authUrl.origin).toBe('https://auth.openai.com');
    expect(authUrl.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(authUrl.searchParams.get('agent_name_hint')).toBe('Obsidian Harness');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/,
    );
    expect(account).toMatchObject({ signedIn: true, active: true });
    expect(await f.auth.listModels()).toEqual([{ id: 'fixture-model', label: 'Fixture Model' }]);
    expect(JSON.stringify(await f.auth.listAccounts())).not.toContain('fixture-access');
    const exchange = f.transport.mock.calls.find(([input]) =>
      input.url.endsWith('/oauth/token'),
    )![0];
    expect(new URLSearchParams(exchange.body).get('redirect_uri')).toBe(
      authUrl.searchParams.get('redirect_uri'),
    );
    expect(new URLSearchParams(exchange.body).get('client_id')).toBe('oaiapp_fixture');
    expect(new URLSearchParams(exchange.body).get('code_verifier')).toBeTruthy();
  });
  it.each([
    { invalidNonce: true },
    { refusePlan: true },
    { invalidAudience: true },
    { invalidIssuer: true },
    { invalidSignature: true },
    { expiredIdentity: true },
  ])('rejects identity or missing plan authorization', async (options) => {
    const f = await oauthFixture(options);
    await expect(f.auth.signIn(f.open)).rejects.toBeInstanceOf(ProviderError);
    expect(await f.auth.listAccounts()).toEqual([]);
    expect([...f.secrets.values.values()].join('')).not.toContain('fixture-access');
  });
  it('reuses issued client ID when signing in again', async () => {
    const f = await oauthFixture();
    const account = await f.auth.signIn(f.open);
    await f.auth.signIn(f.open, undefined, account.id);
    expect(f.getAuthorizeUrl().searchParams.get('client_id')).toBe('oaiapp_fixture');
    expect(f.getAuthorizeUrl().searchParams.has('agent_name_hint')).toBe(false);
    expect(f.getAuthorizeUrl().searchParams.has('id_token_hint')).toBe(true);
    expect(await f.auth.listAccounts()).toHaveLength(1);
  });
  it('serializes token refresh and stores the rotated refresh token', async () => {
    const f = await oauthFixture({ expired: true });
    await f.auth.signIn(f.open);
    await Promise.all([f.auth.listModels(), f.auth.listModels()]);
    expect(f.refreshCount()).toBe(1);
    expect([...f.secrets.values.values()].join('')).toContain('fixture-refresh-renewed');
  });
  it('uses public Responses SSE with store false and no forbidden max_output_tokens', async () => {
    const f = await oauthFixture();
    await f.auth.signIn(f.open);
    const result = await createGenerationProvider(
      { ...config, kind: 'chatgpt', model: 'fixture-model' },
      f.secrets,
      f.auth,
    ).generate(request);
    expect(result.text).toBe('{"ok":true}');
    const call = f.transport.mock.calls.find(([input]) => input.url.endsWith('/responses'))![0];
    expect(call.url).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(call.body!);
    expect(body).toMatchObject({ stream: true, store: false });
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body).not.toHaveProperty('tools');
    expect(body.input.every((m: { role: string }) => m.role !== 'system')).toBe(true);
  });
  it.each([false, true])(
    'clears local tokens and preserves registration when remote revoke fails=%s',
    async (failRevoke) => {
      const f = await oauthFixture({ failRevoke });
      const account = await f.auth.signIn(f.open);
      expect(await f.auth.signOut()).toEqual({ remoteRevocationConfirmed: !failRevoke });
      expect(await f.auth.listAccounts()).toEqual([{ ...account, signedIn: false }]);
      expect([...f.secrets.values.values()].join('')).not.toContain('fixture-access');
      await expect(f.auth.listModels()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    },
  );
  it('ignores invalid callback state and accepts only the correct pending attempt', async () => {
    const f = await oauthFixture();
    await f.auth.signIn(async (value) => {
      const url = new URL(value);
      const bad = new URL(url.searchParams.get('redirect_uri')!);
      bad.search = 'state=wrong&code=stolen&client_id=oaiapp_attacker';
      expect(await callback(bad.href)).toBe(400);
      const wrongPath = new URL(url.searchParams.get('redirect_uri')!);
      wrongPath.pathname = '/wrong/callback';
      wrongPath.search = new URLSearchParams({
        state: url.searchParams.get('state')!,
        code: 'fixture-code',
        client_id: 'oaiapp_fixture',
      }).toString();
      expect(await callback(wrongPath.href)).toBe(404);
      await f.open(value);
    });
    expect(await f.auth.listAccounts()).toHaveLength(1);
  });

  it('rejects repeated callbacks after the single-use listener closes', async () => {
    const f = await oauthFixture();
    await f.auth.signIn(f.open);
    const url = f.getAuthorizeUrl();
    const duplicate = new URL(url.searchParams.get('redirect_uri')!);
    duplicate.search = new URLSearchParams({
      state: url.searchParams.get('state')!,
      code: 'fixture-code',
      client_id: 'oaiapp_fixture',
    }).toString();
    await expect(callback(duplicate.href)).rejects.toBeInstanceOf(Error);
    expect(
      f.transport.mock.calls.filter(([input]) => input.url.endsWith('/oauth/token')),
    ).toHaveLength(1);
  });
  it('rejects an old account response arriving after account switch', async () => {
    const f = await oauthFixture();
    const account = await f.auth.signIn(f.open);
    const original = f.transport.getMockImplementation()!;
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    f.transport.mockImplementation(async (input) => {
      if (input.url.endsWith('/models')) {
        markStarted();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return original(input);
    });
    const pending = f.auth.listModels();
    const rejection = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await started;
    await f.auth.selectAccount(account.id);
    release();
    await rejection;
  });
  it('logout cannot resurrect tokens from an in-flight refresh', async () => {
    const f = await oauthFixture({ expired: true });
    await f.auth.signIn(f.open);
    const original = f.transport.getMockImplementation()!;
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    f.transport.mockImplementation(async (input) => {
      if (input.url.endsWith('/oauth/token')) {
        markStarted();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return original(input);
    });
    const request = f.auth.listModels();
    const rejected = expect(request).rejects.toMatchObject({ code: 'CANCELLED' });
    await started;
    const logout = f.auth.signOut();
    release();
    await rejected;
    await logout;
    expect([...f.secrets.values.values()].join('')).not.toContain('fixture-access');
    expect((await f.auth.listAccounts())[0].signedIn).toBe(false);
  });
  it('cancels pending login and closes loopback listener', async () => {
    const f = await oauthFixture();
    const controller = new AbortController();
    await expect(f.auth.signIn(() => controller.abort(), controller.signal)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(f.transport).not.toHaveBeenCalled();
  });
});

describe('provider retry metadata', () => {
  it('retains bounded Retry-After seconds and HTTP dates without remote body', () => {
    const response = { status: 429, body: 'SENSITIVE', headers: { 'retry-after': '12' } };
    expect(retryAfterMs(response)).toBe(12000);
    expect(
      retryAfterMs(
        { ...response, headers: { 'retry-after': new Date(20000).toUTCString() } },
        10000,
      ),
    ).toBe(10000);
    expect(retryAfterMs({ ...response, headers: { 'retry-after': 'unknown' } })).toBe(0);
    expect(retryAfterMs({ ...response, headers: { 'retry-after': '9999999999' } })).toBe(86400000);
    try {
      assertHttpSuccess(response);
    } catch (error) {
      expect(error).toMatchObject({ retryAfterMs: 12000, retryable: true });
      expect(safeProviderError(error)).not.toContain('SENSITIVE');
    }
  });
});

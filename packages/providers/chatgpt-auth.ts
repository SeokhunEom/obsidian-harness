import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import {
  assertHttpSuccess,
  boundedHttp,
  parseJson,
  type HttpInput,
  type HttpResult,
  type HttpTransport,
} from './http';
import { cancelled, ProviderError, type SecretStore } from './types';

const AUTH = 'https://auth.openai.com';
const API = 'https://api.openai.com/v1';
const SECRET_KEY = 'obsidian-harness.chatgpt.oauth';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
interface Tokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
  scopes: string[];
}
interface Registration {
  id: string;
  clientId: string;
  subject: string;
  email?: string;
  tokens?: Tokens;
}
interface SavedAuth {
  version: 1;
  activeId?: string;
  pendingClientId?: string;
  accounts: Registration[];
}
export interface ChatGPTAccount {
  id: string;
  label: string;
  signedIn: boolean;
  active: boolean;
}
export interface ChatGPTModel {
  id: string;
  label: string;
}
export interface SignOutResult {
  remoteRevocationConfirmed: boolean;
}
function textField(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || !value || value.length > 32768)
    throw new ProviderError('AUTH_INVALID', '인증 응답이 올바르지 않습니다. 다시 로그인하세요.');
  return value;
}
function sameState(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
/** Dedicated OAuth registration; never reads Codex/ChatGPT/browser credentials. */
export class ChatGPTAuth {
  private cache?: SavedAuth;
  private refreshPromise?: Promise<Tokens>;
  private signingIn = false;
  private sessionChanging = false;
  private stateWrites: Promise<void> = Promise.resolve();
  private epoch = 0;
  private controllers = new Set<AbortController>();
  private readonly hostId: string;
  constructor(
    private readonly secrets: SecretStore,
    hostId: string,
    private readonly transport: HttpTransport = boundedHttp,
  ) {
    this.hostId = hostId.startsWith('urn:uuid:') ? hostId : `urn:uuid:${hostId}`;
    if (
      !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        this.hostId,
      )
    )
      throw new ProviderError(
        'CONFIGURATION',
        'ChatGPT 로그인에는 저장된 기기 UUIDv4가 필요합니다.',
      );
  }
  private async load(): Promise<SavedAuth> {
    if (this.cache) return this.cache;
    const saved = await this.secrets.get(SECRET_KEY);
    if (!saved) return (this.cache = { version: 1, accounts: [] });
    try {
      const data = JSON.parse(saved) as SavedAuth;
      if (data.version !== 1 || !Array.isArray(data.accounts) || data.accounts.length > 100)
        throw 0;
      for (const account of data.accounts) {
        if (
          ![account.id, account.clientId, account.subject].every(
            (s) => typeof s === 'string' && s.length > 0,
          ) ||
          account.clientId === 'dynamic_agent_client'
        )
          throw 0;
        if (
          account.tokens &&
          (![account.tokens.accessToken, account.tokens.refreshToken, account.tokens.idToken].every(
            (s) => typeof s === 'string' && s.length > 0,
          ) ||
            !Number.isFinite(account.tokens.expiresAt) ||
            !Array.isArray(account.tokens.scopes))
        )
          throw 0;
      }
      return (this.cache = data);
    } catch {
      throw new ProviderError(
        'AUTH_INVALID',
        '저장된 ChatGPT 인증을 읽을 수 없습니다. 비밀값 저장소를 확인하세요.',
      );
    }
  }
  private async save(update: (current: SavedAuth) => SavedAuth): Promise<void> {
    const write = this.stateWrites.then(async () => {
      const next = update(await this.load());
      await this.secrets.set(SECRET_KEY, JSON.stringify(next));
      this.cache = next;
    });
    this.stateWrites = write.catch(() => undefined);
    await write;
  }
  async listAccounts(): Promise<ChatGPTAccount[]> {
    const state = await this.load();
    return state.accounts.map((a) => ({
      id: a.id,
      label: `${a.email ?? 'ChatGPT 계정'} · ${a.id.slice(0, 8)}`,
      signedIn: Boolean(a.tokens),
      active: a.id === state.activeId,
    }));
  }
  async selectAccount(id: string): Promise<void> {
    if (this.sessionChanging)
      throw new ProviderError('CONFIGURATION', '계정 변경이 진행 중입니다.');
    const state = await this.load();
    if (!state.accounts.some((a) => a.id === id))
      throw new ProviderError('AUTH_REQUIRED', '등록된 ChatGPT 계정을 선택하세요.');
    this.stopRequests();
    await this.refreshPromise?.catch(() => undefined);
    await this.save((current) => ({ ...current, activeId: id }));
  }
  /** Called on unload, account switch, or logout to stop requests immediately. */
  stopRequests(): void {
    this.epoch++;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
  async signIn(
    openExternal: (url: string) => Promise<unknown> | unknown,
    signal?: AbortSignal,
    accountId?: string,
  ): Promise<ChatGPTAccount> {
    if (this.signingIn || this.sessionChanging)
      throw new ProviderError(
        'CONFIGURATION',
        '이미 ChatGPT 로그인 또는 계정 변경이 진행 중입니다.',
      );
    if (signal?.aborted) throw cancelled();
    this.signingIn = true;
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const saved = await this.load();
      const previous = accountId ? saved.accounts.find((a) => a.id === accountId) : undefined;
      if (accountId && !previous)
        throw new ProviderError('AUTH_REQUIRED', '등록된 ChatGPT 계정을 찾을 수 없습니다.');
      const existingClient = previous?.clientId ?? saved.pendingClientId;
      const state = randomBytes(32).toString('base64url');
      const nonce = randomBytes(32).toString('base64url');
      const verifier = randomBytes(48).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const callback = await this.authorize({
        state,
        nonce,
        challenge,
        existingClient,
        previous,
        openExternal,
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw cancelled();
      // Keep the issued ID even if code exchange fails, so retry does not register another client.
      await this.save((current) => ({
        ...current,
        pendingClientId: previous ? current.pendingClientId : callback.clientId,
      }));
      const tokenResponse = parseJson(
        await this.transport({
          url: `${AUTH}/api/accounts/oauth/token`,
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: callback.clientId,
            code: callback.code,
            code_verifier: verifier,
            redirect_uri: callback.redirectUri,
            resource: API,
          }).toString(),
          signal: controller.signal,
          timeoutMs: 30000,
          maxBytes: 256000,
        }),
      );
      const identity = await this.verifyIdentity(
        textField(tokenResponse, 'id_token'),
        callback.clientId,
        controller.signal,
        nonce,
      );
      if (previous && previous.subject !== identity.subject)
        throw new ProviderError('AUTH_INVALID', '선택한 계정과 로그인한 계정이 다릅니다.');
      const tokens = this.readTokens(tokenResponse);
      if (controller.signal.aborted) throw cancelled();
      const id = createHash('sha256')
        .update(`${callback.clientId}\0${identity.subject}`)
        .digest('hex')
        .slice(0, 24);
      this.epoch++;
      for (const active of this.controllers) if (active !== controller) active.abort();
      await this.refreshPromise?.catch(() => undefined);
      if (controller.signal.aborted) throw cancelled();
      const registration: Registration = { id, clientId: callback.clientId, ...identity, tokens };
      await this.save((current) => {
        if (controller.signal.aborted) throw cancelled();
        return {
          version: 1,
          activeId: id,
          accounts: [...current.accounts.filter((a) => a.id !== id), registration],
        };
      });
      return (await this.listAccounts()).find((a) => a.id === id)!;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('AUTH_INVALID', 'ChatGPT 로그인에 실패했습니다. 다시 시도하세요.');
    } finally {
      this.signingIn = false;
      this.controllers.delete(controller);
      signal?.removeEventListener('abort', abort);
    }
  }
  private authorize(input: {
    state: string;
    nonce: string;
    challenge: string;
    existingClient?: string;
    previous?: Registration;
    openExternal: (url: string) => Promise<unknown> | unknown;
    signal: AbortSignal;
  }): Promise<{ code: string; clientId: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      let finished = false;
      let redirectUri = '';
      const server = createServer({ maxHeaderSize: 16384 }, (request, response) => {
        response.setHeader('connection', 'close');
        if (finished) {
          response.writeHead(410).end('Authorization attempt is already closed');
          return;
        }
        response.setHeader('content-type', 'text/plain; charset=utf-8');
        response.setHeader('cache-control', 'no-store');
        response.setHeader('content-security-policy', "default-src 'none'");
        let parsed: URL;
        try {
          parsed = new URL(request.url ?? '', redirectUri);
        } catch {
          response.writeHead(400).end('Invalid callback');
          return;
        }
        if (request.method !== 'GET' || parsed.pathname !== '/auth/callback') {
          response.writeHead(404).end('Not found');
          return;
        }
        const query = parsed.searchParams;
        if (
          ['state', 'code', 'client_id', 'error'].some((key) => query.getAll(key).length > 1) ||
          !sameState(query.get('state') ?? '', input.state)
        ) {
          response.writeHead(400).end('Invalid authorization state');
          return;
        }
        if (query.has('error')) {
          response.writeHead(400).end('Authorization was not completed. Return to Obsidian.');
          finish(new ProviderError('ACCESS_DENIED', 'ChatGPT 로그인이 승인되지 않았습니다.'));
          return;
        }
        const code = query.get('code');
        const clientId = query.get('client_id') ?? input.existingClient;
        if (
          !code ||
          !clientId ||
          clientId === 'dynamic_agent_client' ||
          code.length > 16384 ||
          clientId.length > 512 ||
          (input.existingClient && clientId !== input.existingClient)
        ) {
          response.writeHead(400).end('Invalid authorization response');
          finish(new ProviderError('AUTH_INVALID', 'ChatGPT 등록 응답이 올바르지 않습니다.'));
          return;
        }
        response
          .writeHead(200)
          .end('ChatGPT authorization received. Return to Obsidian to check the result.');
        finish(undefined, { code, clientId, redirectUri });
      });
      const finish = (
        error?: ProviderError,
        result?: { code: string; clientId: string; redirectUri: string },
      ) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        input.signal.removeEventListener('abort', abort);
        server.close();
        if (error) server.closeAllConnections();
        if (error) reject(error);
        else resolve(result!);
      };
      const abort = () => finish(cancelled());
      const timer = setTimeout(
        () =>
          finish(
            new ProviderError('TIMEOUT', 'ChatGPT 로그인 시간이 만료되었습니다. 다시 시도하세요.'),
          ),
        180000,
      );
      input.signal.addEventListener('abort', abort, { once: true });
      if (input.signal.aborted) {
        abort();
        return;
      }
      server.on('error', () =>
        finish(
          new ProviderError(
            'CONFIGURATION',
            '로컬 로그인 콜백을 열 수 없습니다. 방화벽 설정을 확인하세요.',
          ),
        ),
      );
      server.listen(0, '127.0.0.1', () => {
        if (finished) return;
        const address = server.address();
        if (!address || typeof address === 'string') {
          finish(new ProviderError('CONFIGURATION', '로그인 콜백 주소를 만들 수 없습니다.'));
          return;
        }
        redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
        const authorize = new URL(`${AUTH}/api/accounts/authorize`);
        authorize.search = new URLSearchParams({
          client_id: input.existingClient ?? 'dynamic_agent_client',
          ext_agent_host_id: this.hostId,
          response_type: 'code',
          redirect_uri: redirectUri,
          scope: SCOPES,
          resource: API,
          state: input.state,
          nonce: input.nonce,
          code_challenge_method: 'S256',
          code_challenge: input.challenge,
        }).toString();
        if (!input.existingClient)
          authorize.searchParams.set('agent_name_hint', 'Obsidian Harness');
        if (input.previous?.tokens?.idToken)
          authorize.searchParams.set('id_token_hint', input.previous.tokens.idToken);
        if (input.previous?.email) authorize.searchParams.set('login_hint', input.previous.email);
        // The URL can contain an ID token hint; never log or persist it.
        Promise.resolve()
          .then(() => input.openExternal(authorize.href))
          .catch(() =>
            finish(new ProviderError('CONFIGURATION', '기본 브라우저를 열 수 없습니다.')),
          );
      });
    });
  }
  private async verifyIdentity(
    idToken: string,
    clientId: string,
    signal?: AbortSignal,
    nonce?: string,
  ): Promise<{ subject: string; email?: string }> {
    try {
      const keys = parseJson(
        await this.transport({
          url: `${AUTH}/.well-known/jwks.json`,
          signal,
          timeoutMs: 15000,
          maxBytes: 256000,
        }),
      );
      const { payload } = await jwtVerify(
        idToken,
        createLocalJWKSet(keys as unknown as JSONWebKeySet),
        {
          issuer: AUTH,
          audience: clientId,
          algorithms: ['RS256'],
          requiredClaims: ['sub', 'exp', 'iat'],
          clockTolerance: 5,
        },
      );
      if (!payload.sub || (nonce && payload.nonce !== nonce)) throw 0;
      return {
        subject: payload.sub,
        ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        'AUTH_INVALID',
        'ChatGPT ID 토큰 검증에 실패했습니다. 다시 로그인하세요.',
      );
    }
  }
  private readTokens(data: Record<string, unknown>, previous?: Tokens): Tokens {
    if (data.token_type !== 'Bearer' && data.token_type !== 'bearer')
      throw new ProviderError('AUTH_INVALID', '지원하지 않는 인증 토큰입니다.');
    const scopes =
      typeof data.scope === 'string'
        ? data.scope.split(/\s+/).filter(Boolean)
        : (previous?.scopes ?? []);
    if (!scopes.includes('chatgpt.tokens.use.direct') || !scopes.includes('resource.invoke'))
      throw new ProviderError(
        'ACCESS_DENIED',
        '이 앱의 ChatGPT 요금제 사용 권한이 필요합니다. ChatGPT 설정에서 허용하세요.',
      );
    if (
      typeof data.expires_in !== 'number' ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0 ||
      data.expires_in > 86400
    )
      throw new ProviderError('AUTH_INVALID', '인증 만료 정보를 확인할 수 없습니다.');
    return {
      accessToken: textField(data, 'access_token'),
      refreshToken: textField(data, 'refresh_token'),
      idToken:
        typeof data.id_token === 'string'
          ? textField(data, 'id_token')
          : (previous?.idToken ?? textField(data, 'id_token')),
      expiresAt: Date.now() + data.expires_in * 1000,
      scopes,
    };
  }
  private async activeTokens(): Promise<Tokens> {
    const state = await this.load();
    const account = state.accounts.find((a) => a.id === state.activeId);
    if (!account?.tokens)
      throw new ProviderError('AUTH_REQUIRED', 'Continue with ChatGPT로 로그인하세요.');
    if (account.tokens.expiresAt > Date.now() + 60000) return account.tokens;
    if (this.refreshPromise) return this.refreshPromise;
    const epoch = this.epoch;
    const controller = new AbortController();
    this.controllers.add(controller);
    this.refreshPromise = (async () => {
      const response = parseJson(
        await this.transport({
          url: `${AUTH}/api/accounts/oauth/token`,
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: account.clientId,
            refresh_token: account.tokens!.refreshToken,
            resource: API,
          }).toString(),
          signal: controller.signal,
          timeoutMs: 30000,
          maxBytes: 256000,
        }),
      );
      if (typeof response.id_token === 'string') {
        const identity = await this.verifyIdentity(
          response.id_token,
          account.clientId,
          controller.signal,
        );
        if (identity.subject !== account.subject)
          throw new ProviderError('AUTH_INVALID', '갱신된 ChatGPT 계정 정보가 일치하지 않습니다.');
      }
      const tokens = this.readTokens(response, account.tokens);
      if (epoch !== this.epoch || controller.signal.aborted) throw cancelled();
      await this.save((current) => {
        if (epoch !== this.epoch || controller.signal.aborted) throw cancelled();
        return {
          ...current,
          accounts: current.accounts.map((a) => (a.id === account.id ? { ...a, tokens } : a)),
        };
      });
      return tokens;
    })();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = undefined;
      this.controllers.delete(controller);
    }
  }
  /** Only these fixed OpenAI endpoints receive the selected account's bearer token. */
  async request(
    path: 'models' | 'responses',
    input: Omit<HttpInput, 'url' | 'headers' | 'allowPrivateHttp'> = {},
  ): Promise<HttpResult> {
    if (input.signal?.aborted) throw cancelled();
    const epoch = this.epoch;
    const tokens = await this.activeTokens();
    if (epoch !== this.epoch || input.signal?.aborted) throw cancelled();
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = () => controller.abort();
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.transport({
        ...input,
        url: `${API}/${path}`,
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
          'content-type': 'application/json',
        },
        signal: controller.signal,
      });
      if (epoch !== this.epoch || controller.signal.aborted) throw cancelled();
      return response;
    } finally {
      this.controllers.delete(controller);
      input.signal?.removeEventListener('abort', abort);
    }
  }
  async listModels(signal?: AbortSignal): Promise<ChatGPTModel[]> {
    const data = parseJson(
      await this.request('models', { signal, timeoutMs: 15000, maxBytes: 1024000 }),
    );
    if (!Array.isArray(data.models))
      throw new ProviderError('INVALID_RESPONSE', 'ChatGPT 모델 목록을 확인할 수 없습니다.');
    return data.models
      .filter((v): v is { slug: string; display_name: string; visibility: string } =>
        Boolean(
          v &&
          typeof v === 'object' &&
          v.visibility === 'list' &&
          typeof v.slug === 'string' &&
          typeof v.display_name === 'string',
        ),
      )
      .map((v) => ({ id: v.slug, label: v.display_name }));
  }
  async signOut(accountId?: string): Promise<SignOutResult> {
    if (this.sessionChanging)
      throw new ProviderError('CONFIGURATION', '계정 변경이 진행 중입니다.');
    this.sessionChanging = true;
    try {
      return await this.revokeAccount(accountId);
    } finally {
      this.sessionChanging = false;
    }
  }
  private async revokeAccount(accountId?: string): Promise<SignOutResult> {
    this.stopRequests();
    await this.refreshPromise?.catch(() => undefined);
    const state = await this.load();
    const id = accountId ?? state.activeId;
    const account = state.accounts.find((a) => a.id === id);
    if (!account?.tokens) return { remoteRevocationConfirmed: true };
    let remoteRevocationConfirmed = false;
    try {
      const metadata = parseJson(
        await this.transport({
          url: `${AUTH}/.well-known/openid-configuration`,
          timeoutMs: 10000,
          maxBytes: 256000,
        }),
      );
      // Discovery is data, never authority to send a credential to a different origin/path.
      if (
        metadata.issuer !== AUTH ||
        metadata.revocation_endpoint !== `${AUTH}/api/accounts/oauth/revoke`
      )
        throw new ProviderError('ENDPOINT_BLOCKED', '인증 해제 주소를 검증할 수 없습니다.');
      const result = await this.transport({
        url: metadata.revocation_endpoint,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: account.tokens.refreshToken,
          token_type_hint: 'refresh_token',
          client_id: account.clientId,
        }).toString(),
        timeoutMs: 10000,
        maxBytes: 256000,
      });
      assertHttpSuccess(result);
      remoteRevocationConfirmed = result.status === 200;
    } catch {
      /* Clear local credentials even when the remote service cannot be reached. */
    }
    await this.save((current) => ({
      ...current,
      accounts: current.accounts.map((a) =>
        a.id === id ? { id: a.id, clientId: a.clientId, subject: a.subject, email: a.email } : a,
      ),
    }));
    return { remoteRevocationConfirmed };
  }
}

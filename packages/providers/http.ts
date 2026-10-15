import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { cancelled, ProviderError, type ProviderConfig } from './types';

export interface HttpInput {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  allowPrivateHttp?: boolean;
}
export interface HttpResult {
  status: number;
  body: string;
  headers?: Record<string, string>;
}
export type HttpTransport = (input: HttpInput) => Promise<HttpResult>;
const hostName = (url: URL) => url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(host);
}
function isPrivate(host: string): boolean {
  return (
    isLoopback(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^(fc|fd)[\da-f]{2}:/i.test(host)
  );
}
export function normalizedBase(
  config: Pick<ProviderConfig, 'kind' | 'baseUrl' | 'allowPrivateHttp'>,
): URL {
  if (config.kind === 'chatgpt') return new URL('https://api.openai.com/v1/');
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw new ProviderError('CONFIGURATION', '올바른 모델 서버 URL을 입력하세요.');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['https:', 'http:'].includes(url.protocol)
  ) {
    throw new ProviderError(
      'ENDPOINT_BLOCKED',
      'URL의 인증 정보, 쿼리, 프래그먼트 또는 프로토콜은 허용되지 않습니다.',
    );
  }
  if (url.protocol === 'http:' && !isLoopback(hostName(url)) && !config.allowPrivateHttp) {
    throw new ProviderError(
      'ENDPOINT_BLOCKED',
      'HTTP는 로컬 주소 또는 명시적으로 허용한 사내 주소에서만 사용할 수 있습니다.',
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  return url;
}
export function getDestination(config: ProviderConfig): string {
  return `${config.id}|${config.kind}|${normalizedBase(config).href}|${config.model.trim()}`;
}
export function getTarget(config: ProviderConfig): 'local' | 'external' {
  return config.kind !== 'chatgpt' && isLoopback(hostName(normalizedBase(config)))
    ? 'local'
    : 'external';
}
export function endpoint(config: ProviderConfig, path: string): string {
  const base = normalizedBase(config);
  const result = new URL(path, base);
  if (result.origin !== base.origin || !result.pathname.startsWith(base.pathname))
    throw new ProviderError('ENDPOINT_BLOCKED', '설정 범위 밖의 요청입니다.');
  return result.href;
}
/** Bounds the whole request including DNS; pins the resolved IP and never follows redirects. */
export const boundedHttp: HttpTransport = async (input) => {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new ProviderError('ENDPOINT_BLOCKED', '잘못된 요청 주소입니다.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw new ProviderError('ENDPOINT_BLOCKED', '허용되지 않는 요청 주소입니다.');
  if (input.signal?.aborted) throw cancelled();
  const timeout = Math.min(Math.max(input.timeoutMs ?? 60000, 100), 300000);
  const maxBytes = Math.min(input.maxBytes ?? 8 * 1024 * 1024, 32 * 1024 * 1024);
  if (Buffer.byteLength(input.body ?? '', 'utf8') > 4 * 1024 * 1024)
    throw new ProviderError('OUTPUT_LIMIT', '모델 요청 크기 상한을 초과했습니다.');
  return new Promise<HttpResult>((resolve, reject) => {
    let finished = false;
    let active: ReturnType<typeof httpRequest> | undefined;
    const finish = (error?: ProviderError, result?: HttpResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      if (error) {
        active?.destroy();
        reject(error);
      } else resolve(result!);
    };
    const abort = () => finish(cancelled());
    const timer = setTimeout(
      () => finish(new ProviderError('TIMEOUT', '모델 응답 제한 시간을 초과했습니다.', true)),
      timeout,
    );
    input.signal?.addEventListener('abort', abort, { once: true });
    const host = hostName(url);
    const addresses =
      host === 'localhost'
        ? Promise.resolve([{ address: '127.0.0.1', family: 4 }])
        : isIP(host)
          ? Promise.resolve([{ address: host, family: isIP(host) }])
          : lookup(host, { all: true });
    void addresses.then(
      (resolved) => {
        if (finished) return;
        if (
          !resolved.length ||
          (url.protocol === 'http:' &&
            !resolved.every(
              ({ address }) =>
                isLoopback(address) || Boolean(input.allowPrivateHttp && isPrivate(address)),
            ))
        ) {
          finish(
            new ProviderError(
              'ENDPOINT_BLOCKED',
              'HTTP 목적지가 로컬 또는 허용한 사내 네트워크가 아닙니다.',
            ),
          );
          return;
        }
        if (isLoopback(host) && !resolved.every(({ address }) => isLoopback(address))) {
          finish(
            new ProviderError(
              'ENDPOINT_BLOCKED',
              '로컬 모델 주소가 로컬 주소로 해석되지 않습니다.',
            ),
          );
          return;
        }
        const selected = resolved[0];
        try {
          active = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
            url,
            {
              family: selected.family,
              method: input.method ?? 'GET',
              headers: {
                ...input.headers,
                ...(input.body !== undefined
                  ? { 'content-length': String(Buffer.byteLength(input.body)) }
                  : {}),
              },
              lookup: (_hostname, _options, callback) =>
                callback(null, selected.address, selected.family),
            },
            (response) => {
              const status = response.statusCode ?? 0;
              if (status >= 300 && status < 400) {
                finish(
                  new ProviderError(
                    'ENDPOINT_BLOCKED',
                    '리다이렉트를 차단했습니다. 최종 서버 URL을 직접 설정하세요.',
                  ),
                );
                return;
              }
              let size = 0;
              const chunks: Buffer[] = [];
              response.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > maxBytes) {
                  finish(new ProviderError('OUTPUT_LIMIT', '모델 응답 크기 상한을 초과했습니다.'));
                  return;
                }
                chunks.push(chunk);
              });
              response.on('end', () =>
                finish(undefined, {
                  status,
                  body: Buffer.concat(chunks).toString('utf8'),
                  headers: Object.fromEntries(
                    Object.entries(response.headers)
                      .filter((entry) => entry[1] !== undefined)
                      .map(([key, value]) => [
                        key,
                        Array.isArray(value) ? value.join(', ') : String(value),
                      ]),
                  ),
                }),
              );
              response.on('error', () =>
                finish(new ProviderError('NETWORK', '모델 연결이 중단되었습니다.', true)),
              );
              response.on('aborted', () =>
                finish(new ProviderError('NETWORK', '모델 연결이 중단되었습니다.', true)),
              );
            },
          );
          active.on('error', () =>
            finish(new ProviderError('NETWORK', '모델 서버에 연결할 수 없습니다.', true)),
          );
          active.end(input.body);
        } catch {
          finish(new ProviderError('CONFIGURATION', '요청 설정이 잘못되었습니다.'));
        }
      },
      () => finish(new ProviderError('NETWORK', '모델 서버 주소를 확인할 수 없습니다.', true)),
    );
  });
};
export function retryAfterMs(result: HttpResult, now = Date.now()): number {
  const value = result.headers?.['retry-after'];
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return 0;
  const delay = /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) * 1000 : Date.parse(raw) - now;
  return Number.isFinite(delay) ? Math.min(86400000, Math.max(0, delay)) : 0;
}
export function assertHttpSuccess(result: HttpResult): void {
  if (result.status >= 200 && result.status < 300) return;
  if (result.status === 401)
    throw new ProviderError(
      'AUTH_INVALID',
      '인증이 만료되었거나 비밀값이 잘못되었습니다. 다시 로그인하거나 키를 확인하세요.',
    );
  if (result.status === 403)
    throw new ProviderError('ACCESS_DENIED', '모델 또는 계정의 접근 권한을 확인하세요.');
  if (result.status === 429)
    throw new ProviderError(
      'RATE_LIMITED',
      '사용 한도에 도달했습니다. 계정 사용량을 확인하세요.',
      true,
      retryAfterMs(result),
    );
  if (result.status >= 500)
    throw new ProviderError(
      'SERVER',
      '모델 서버에서 오류가 발생했습니다.',
      true,
      retryAfterMs(result),
    );
  if ([400, 404, 405, 422].includes(result.status))
    throw new ProviderError(
      'UNSUPPORTED',
      '모델명, API 경로 또는 구조화 출력 지원 설정을 확인하세요.',
    );
  throw new ProviderError(
    'INVALID_RESPONSE',
    '모델 요청이 거절되었습니다. 연결 설정을 확인하세요.',
  );
}
export function parseJson(result: HttpResult): Record<string, unknown> {
  assertHttpSuccess(result);
  try {
    const parsed: unknown = JSON.parse(result.body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw 0;
    return parsed as Record<string, unknown>;
  } catch {
    throw new ProviderError('INVALID_RESPONSE', '모델 응답의 JSON 형식이 잘못되었습니다.');
  }
}

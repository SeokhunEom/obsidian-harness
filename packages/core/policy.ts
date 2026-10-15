import type { Policy, SourceRef } from '../contracts';

export class PolicyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PolicyError';
  }
}
/** Vault-relative, literal paths only. `.` is reserved for an explicit whole-vault grant. */
export function normalizeVaultPath(value: string, allowRoot = false): string {
  if (allowRoot && value === '.') return '.';
  if (
    !value ||
    value !== value.trim() ||
    /[\\:%\u0000-\u001f\u007f]/u.test(value) ||
    value.startsWith('/') ||
    value.endsWith('/')
  )
    throw new PolicyError(
      'INVALID_PATH',
      'Vault 상대 경로만 허용합니다. 절대 경로, 인코딩, 역슬래시는 사용할 수 없습니다.',
    );
  const parts = value.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.endsWith('.') || p.endsWith(' ')))
    throw new PolicyError('INVALID_PATH', '경로 별칭과 상위 경로 이동은 허용하지 않습니다.');
  return value;
}
export function inScope(path: string, scopes: string[]): boolean {
  const target = normalizeVaultPath(path);
  return scopes.some((scope) => {
    try {
      const s = normalizeVaultPath(scope, true);
      return s === '.' || target === s || target.startsWith(`${s}/`);
    } catch {
      return false;
    }
  });
}
function protectedPath(path: string): boolean {
  return path.split('/').some((p) => ['.obsidian', '.git', '.trash'].includes(p.toLowerCase()));
}
function checkVault(policy: Policy, path: string, write = false): void {
  const p = normalizeVaultPath(path);
  if (
    protectedPath(p) ||
    inScope(p, policy.excludedPaths) ||
    (!write && inScope(p, policy.operationalPaths))
  )
    throw new PolicyError('PATH_EXCLUDED', '제외 또는 운영 경로에는 접근할 수 없습니다.');
  if (!inScope(p, write ? policy.writePaths : policy.readPaths))
    throw new PolicyError(
      write ? 'WRITE_DENIED' : 'READ_DENIED',
      `${write ? '쓰기' : '읽기'} 범위에 없는 경로입니다: ${p}`,
    );
}
export function githubRepository(path: string): string {
  const match =
    /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\/(?:issues|pulls)\/[1-9][0-9]*(?:\/comments\/[1-9][0-9]*)?)?$/.exec(
      path,
    );
  if (!match) throw new PolicyError('INVALID_REPO', '잘못된 GitHub 근거 경로입니다.');
  return repoName(match[1]);
}
function repoName(path: string): string {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path) ||
    path.split('/').some((s) => s === '.' || s === '..')
  )
    throw new PolicyError('INVALID_REPO', '정확한 owner/repository 형식이 필요합니다.');
  return path.toLowerCase();
}
export function assertRead(policy: Policy, ref: Pick<SourceRef, 'kind' | 'path'>): void {
  if (ref.kind === 'vault') checkVault(policy, ref.path);
  else if (ref.kind === 'github') {
    if (!policy.githubRepos.map(repoName).includes(githubRepository(ref.path)))
      throw new PolicyError('READ_DENIED', '허용하지 않은 GitHub 저장소입니다.');
  } else throw new PolicyError('SOURCE_DENIED', '알 수 없는 자료 유형입니다.');
}
export function isReadable(policy: Policy, ref: Pick<SourceRef, 'kind' | 'path'>): boolean {
  try {
    assertRead(policy, ref);
    return true;
  } catch {
    return false;
  }
}
export function assertWrite(policy: Policy, path: string): void {
  checkVault(policy, path, true);
  if (!path.toLowerCase().endsWith('.md'))
    throw new PolicyError('WRITE_DENIED', 'Markdown 파일만 작성할 수 있습니다.');
}
/** Destination is the exact provider endpoint + model + purpose fingerprint; no URL wildcard. */
export function assertTransfer(
  policy: Policy,
  refs: SourceRef[],
  destination: string,
  userInput = true,
): void {
  const grants = policy.transfers.filter((g) => g.destination === destination);
  if (!destination || !grants.length || (userInput && !grants.some((g) => g.allowUserInput)))
    throw new PolicyError(
      'TRANSFER_DENIED',
      '이 모델 목적지로 사용자 입력을 전송하도록 허용하지 않았습니다.',
    );
  for (const ref of refs) {
    assertRead(policy, ref);
    const permitted = grants.some((g) =>
      ref.kind === 'vault'
        ? inScope(ref.path, g.paths)
        : g.githubRepos.map(repoName).includes(githubRepository(ref.path)),
    );
    if (!permitted)
      throw new PolicyError(
        'TRANSFER_DENIED',
        `이 모델 목적지로 전송할 수 없는 근거입니다: ${ref.path}`,
      );
  }
}

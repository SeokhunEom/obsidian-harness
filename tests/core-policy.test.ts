import { describe, expect, it } from 'vitest';
import { EMPTY_POLICY, type Policy, type SourceRef } from '../packages/contracts';
import { assertRead, assertTransfer, assertWrite, normalizeVaultPath } from '../packages/core';
const source = (path: string, kind: 'vault' | 'github' = 'vault'): SourceRef => ({
  id: path,
  path,
  kind,
  uri: path,
  title: path,
  hash: 'abc',
  updatedAt: 1,
  indexedAt: 1,
});
const policy = (): Policy => ({
  ...structuredClone(EMPTY_POLICY),
  readPaths: ['Work'],
  writePaths: ['Daily'],
  githubRepos: ['org/repo'],
  transfers: [
    {
      destination: 'generation:http://localhost:11434/api/chat:model-a',
      paths: ['Work/Public'],
      githubRepos: [],
      allowUserInput: true,
    },
  ],
});
describe('separate path and destination policies', () => {
  it('starts with no read/write/transfer grants', () => {
    expect(() => assertRead(EMPTY_POLICY, source('Work/a.md'))).toThrow();
    expect(() => assertWrite(EMPTY_POLICY, 'Daily/a.md')).toThrow();
    expect(() => assertTransfer(EMPTY_POLICY, [], 'local')).toThrow();
  });
  it.each([
    '../secret.md',
    'Work/../secret.md',
    '/Work/a.md',
    'C:/Work/a.md',
    'Work\\a.md',
    'Work/%2e%2e/a.md',
    'Work/%252e%252e/a.md',
    'Work//a.md',
    'Work/./a.md',
    'Work/a.md.',
    'Work/a.md ',
    'Work/\u0000a.md',
  ])('rejects path bypass %s', (path) => {
    expect(() => normalizeVaultPath(path)).toThrow();
  });
  it('matches exact subtrees and requires explicit dot for the whole vault', () => {
    assertRead(policy(), source('Work/a.md'));
    expect(() => assertRead(policy(), source('Work-secret/a.md'))).toThrow();
    expect(() => assertRead({ ...policy(), readPaths: ['/'] }, source('Work/a.md'))).toThrow();
    assertRead({ ...policy(), readPaths: ['.'] }, source('else/a.md'));
  });
  it.each([
    '.obsidian/config.md',
    'Work/.git/a.md',
    'Work/.trash/a.md',
    'Harness/run.md',
    'Work/.ObSiDiAn/a.md',
  ])('excludes protected path %s even with whole-vault read', (path) => {
    expect(() => assertRead({ ...policy(), readPaths: ['.'] }, source(path))).toThrow();
  });
  it('separates reads, writes, external transfer, and exact model destinations', () => {
    const p = policy();
    assertRead(p, source('Work/local.md'));
    assertWrite(p, 'Daily/today.md');
    expect(() => assertWrite(p, 'Work/local.md')).toThrow();
    expect(() => assertRead(p, source('Daily/today.md'))).toThrow();
    const destination = p.transfers[0].destination;
    assertTransfer(p, [source('Work/Public/a.md')], destination);
    expect(() => assertTransfer(p, [source('Work/local.md')], destination)).toThrow();
    expect(() => assertTransfer(p, [], destination.replace('model-a', 'model-b'))).toThrow();
    expect(() => assertTransfer(p, [], destination.replace('generation:', 'embedding:'))).toThrow();
    p.transfers[0].allowUserInput = false;
    expect(() => assertTransfer(p, [], destination)).toThrow();
    assertTransfer(p, [source('Work/Public/a.md')], destination, false);
    p.readPaths = [];
    expect(() => assertTransfer(p, [source('Work/Public/a.md')], destination, false)).toThrow();
  });
  it('GitHub allowlists are exact repositories and transfer grants are independent', () => {
    const p = policy();
    assertRead(p, source('ORG/REPO', 'github'));
    assertRead(p, source('org/repo/issues/123/comments/456', 'github'));
    expect(() => assertRead(p, source('org/repo/../secret', 'github'))).toThrow();
    expect(() => assertRead(p, source('org/repo/issues/123/../../secret', 'github'))).toThrow();
    expect(() => assertRead(p, source('org/repository', 'github'))).toThrow();
    expect(() =>
      assertTransfer(p, [source('org/repo', 'github')], p.transfers[0].destination),
    ).toThrow();
    p.transfers[0].githubRepos = ['org/repo'];
    assertTransfer(p, [source('org/repo', 'github')], p.transfers[0].destination);
  });
});

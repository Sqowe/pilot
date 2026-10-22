import { describe, expect, it } from 'vitest';
import {
  formatGitHubRepo,
  isValidGitHubOwner,
  isValidGitHubRepoName,
  isValidGitRef,
  normalizeRepoSubpath,
  parseGitHubPluginUrl,
} from '../../shared/plugin-github-url';

describe('parseGitHubPluginUrl — accepted forms', () => {
  it.each([
    ['https://github.com/coreyhaines31/marketingskills', {}],
    ['https://github.com/coreyhaines31/marketingskills.git', {}],
    ['https://github.com/coreyhaines31/marketingskills/', {}],
    ['http://github.com/coreyhaines31/marketingskills', {}],
    ['https://www.github.com/coreyhaines31/marketingskills', {}],
    ['github.com/coreyhaines31/marketingskills', {}],
    ['git@github.com:coreyhaines31/marketingskills.git', {}],
    ['coreyhaines31/marketingskills', {}],
    ['  https://github.com/coreyhaines31/marketingskills  ', {}],
    ['https://github.com/coreyhaines31/marketingskills?tab=readme#install', {}],
  ])('%s', (input, extra) => {
    expect(parseGitHubPluginUrl(input)).toEqual({
      owner: 'coreyhaines31',
      repo: 'marketingskills',
      ...extra,
    });
  });

  it('takes the ref from /tree/<ref>', () => {
    expect(parseGitHubPluginUrl('https://github.com/o/r/tree/v2.13.0')).toEqual({
      owner: 'o',
      repo: 'r',
      ref: 'v2.13.0',
    });
  });

  it('takes ref and folder from /tree/<ref>/<folder>', () => {
    expect(
      parseGitHubPluginUrl(
        'https://github.com/anthropics/claude-code/tree/main/plugins/code-review'
      )
    ).toEqual({
      owner: 'anthropics',
      repo: 'claude-code',
      ref: 'main',
      path: 'plugins/code-review',
    });
  });

  it('decodes percent-encoded folder names', () => {
    expect(parseGitHubPluginUrl('https://github.com/o/r/tree/main/my%20plugin')).toEqual({
      owner: 'o',
      repo: 'r',
      ref: 'main',
      path: 'my plugin',
    });
  });

  it('accepts a host in any case', () => {
    expect(parseGitHubPluginUrl('https://GitHub.com/o/r')).toEqual({ owner: 'o', repo: 'r' });
  });
});

describe('parseGitHubPluginUrl — refused input', () => {
  it.each([
    '',
    '   ',
    'marketingskills',
    'https://gitlab.com/o/r',
    'https://github.com.evil.example/o/r',
    'https://evil.example/github.com/o/r',
    'https://user:token@github.com/o/r',
    'https://github.com:8443/o/r',
    'ftp://github.com/o/r',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://github.com/o',
    'https://github.com/o/r/blob/main/README.md',
    'https://github.com/o/r/releases',
    'https://github.com/o/r/tree',
    'https://github.com/o/r/tree/main/../secrets',
    'https://github.com/o/r/tree/main/%2e%2e/x',
    'https://github.com/o/r/tree/main/a%5Cb',
    'https://github.com/o/r/tree/main/a%00b',
    'https://github.com/o/r/tree/..%2Fx',
    'https://github.com/o/r/tree/-flag',
    'https://github.com/-o/r',
    'https://github.com/o/..',
    'https://github.com/o/.',
    'o/r/extra',
    'o/r with space',
    'git@gitlab.com:o/r.git',
    `https://github.com/o/${'r'.repeat(101)}`,
    `https://github.com/o/r/tree/main/${'a/'.repeat(1100)}`,
  ])('%s', (input) => {
    expect(parseGitHubPluginUrl(input)).toBeNull();
  });

  it('refuses a value that is not a string', () => {
    expect(parseGitHubPluginUrl(undefined as unknown as string)).toBeNull();
    expect(parseGitHubPluginUrl({} as unknown as string)).toBeNull();
  });
});

describe('validators', () => {
  it('isValidGitRef', () => {
    expect(isValidGitRef('main')).toBe(true);
    expect(isValidGitRef('feature/add-x')).toBe(true);
    expect(isValidGitRef('v1.2.3+build')).toBe(true);
    expect(isValidGitRef('a'.repeat(40))).toBe(true);
    for (const bad of ['', '..', 'a..b', '/main', 'main/', 'a//b', '-x', 'x.lock', 'a b', 'a~1']) {
      expect(isValidGitRef(bad)).toBe(false);
    }
  });

  it('normalizeRepoSubpath', () => {
    expect(normalizeRepoSubpath(['plugins', 'x'])).toBe('plugins/x');
    expect(normalizeRepoSubpath(['', 'plugins', '', 'x', ''])).toBe('plugins/x');
    expect(normalizeRepoSubpath([])).toBeNull();
    expect(normalizeRepoSubpath(['..'])).toBeNull();
    expect(normalizeRepoSubpath(['a', '.', 'b'])).toBeNull();
    expect(normalizeRepoSubpath(['a\\b'])).toBeNull();
    expect(normalizeRepoSubpath(['a\u0007'])).toBeNull();
  });

  it('owner and repo names', () => {
    expect(isValidGitHubOwner('coreyhaines31')).toBe(true);
    expect(isValidGitHubOwner('-x')).toBe(false);
    expect(isValidGitHubRepoName('marketingskills')).toBe(true);
    expect(isValidGitHubRepoName('x.git')).toBe(false);
    expect(isValidGitHubRepoName('..')).toBe(false);
  });

  it('formatGitHubRepo', () => {
    expect(formatGitHubRepo({ owner: 'o', repo: 'r' })).toBe('o/r');
  });
});

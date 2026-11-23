/**
 * Settings resolution tests: .env parsing/loading and the precedence
 * chain flags > environment > .env > config file > built-in defaults.
 *
 * Each test runs in a fresh temp directory with TUTDUB_CONFIG_HOME pointed
 * at it. `TUTDUB_ENV_FILE` is pre-set to an empty file so the loader never
 * picks up an unrelated `.env` from the package directory (a developer may
 * legitimately keep one there for manual runs).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_FRONTEND,
  DEFAULT_SERVER,
  getSettings,
  loadDotEnv,
  parseDotEnv,
  saveConfig,
} from '../src/config';

const TOUCHED = [
  'TUTDUB_SERVER_URL',
  'TUTDUB_FRONTEND_URL',
  'TUTDUB_TOKEN',
  'TUTDUB_CONFIG_HOME',
  'TUTDUB_ENV_FILE',
] as const;

let saved: Record<string, string | undefined> = {};
let dir: string;

beforeEach(() => {
  saved = {};
  for (const key of TOUCHED) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  dir = mkdtempSync(join(tmpdir(), 'tutdub-mcp-env-'));
  // Isolate from the real config file...
  process.env.TUTDUB_CONFIG_HOME = join(dir, 'config');
  // ...and from any .env in the package directory for no-arg loadDotEnv()
  // / getSettings() calls (which otherwise default to the cwd).
  const neutral = join(dir, 'neutral.env');
  writeFileSync(neutral, '');
  process.env.TUTDUB_ENV_FILE = neutral;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of TOUCHED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('parseDotEnv', () => {
  test('parses assignments, export, quotes and comments', () => {
    const parsed = parseDotEnv(
      [
        '# comment line',
        '',
        'A=one',
        'export B=two',
        'C="https://x/api#frag"',
        "D='single'",
        'E=value # trailing comment',
        'F=no#hash',
        'G=',
        'H="two words"',
        'J=  pad  ',
        'I = spaced-key',
        'not-an-assignment',
        '=novalue',
        '1BAD=x',
      ].join('\r\n'),
    );
    expect(parsed).toEqual({
      A: 'one',
      B: 'two',
      C: 'https://x/api#frag',
      D: 'single',
      E: 'value',
      F: 'no#hash',
      G: '',
      H: 'two words',
      I: 'spaced-key',
      J: 'pad',
    });
  });

  test('returns nothing for an empty or comment-only file', () => {
    expect(parseDotEnv('# only a comment\n\n')).toEqual({});
    expect(parseDotEnv('')).toEqual({});
  });
});

describe('loadDotEnv / getSettings', () => {
  test('fills unset variables from <dir>/.env', () => {
    writeFileSync(
      join(dir, '.env'),
      'TUTDUB_SERVER_URL=http://env.example/api\n' +
        'TUTDUB_FRONTEND_URL=http://env.example/app\n',
    );

    const applied = loadDotEnv(dir);
    expect(applied).toEqual(['TUTDUB_SERVER_URL', 'TUTDUB_FRONTEND_URL']);

    // Applied values flow into the resolved settings.
    const settings = getSettings();
    expect(settings.server).toBe('http://env.example/api');
    expect(settings.frontend).toBe('http://env.example/app');
  });

  test('never overrides variables already in the environment', () => {
    process.env.TUTDUB_SERVER_URL = 'https://real.example/api';
    writeFileSync(
      join(dir, '.env'),
      'TUTDUB_SERVER_URL=http://file.example/api\n',
    );

    expect(loadDotEnv(dir)).toEqual([]); // nothing applied - already set
    expect(getSettings().server).toBe('https://real.example/api');
  });

  test('command-line flags beat .env', () => {
    writeFileSync(join(dir, '.env'), 'TUTDUB_SERVER_URL=http://file.example/api\n');
    loadDotEnv(dir);

    expect(getSettings({ server: 'https://flag.example/api' }).server).toBe(
      'https://flag.example/api',
    );
  });

  test('.env beats the config file', () => {
    saveConfig({ server: 'https://cfg.example/api' });
    // No .env applied yet -> the saved config wins.
    expect(getSettings().server).toBe('https://cfg.example/api');

    writeFileSync(join(dir, '.env'), 'TUTDUB_SERVER_URL=http://file.example/api\n');
    loadDotEnv(dir);

    expect(getSettings().server).toBe('http://file.example/api');
  });

  test('TUTDUB_ENV_FILE loads an explicit file (any cwd)', () => {
    const explicit = join(dir, 'custom.env');
    writeFileSync(explicit, 'TUTDUB_FRONTEND_URL=http://explicit.example/app\n');
    process.env.TUTDUB_ENV_FILE = explicit;

    // No baseDir -> the TUTDUB_ENV_FILE branch of the resolution chain.
    expect(loadDotEnv()).toContain('TUTDUB_FRONTEND_URL');
    expect(getSettings().frontend).toBe('http://explicit.example/app');
  });

  test('warns once when TUTDUB_ENV_FILE points to a missing file', () => {
    const missing = join(dir, 'does-not-exist.env');
    process.env.TUTDUB_ENV_FILE = missing;

    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(' '));
    try {
      expect(loadDotEnv()).toEqual([]);
      expect(loadDotEnv()).toEqual([]); // second call: no repeated warning
    } finally {
      console.error = original;
    }

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(missing);
  });

  test('falls back to the built-in defaults when nothing is set', () => {
    // TUTDUB_ENV_FILE points at the empty neutral file from beforeEach.
    expect(loadDotEnv()).toEqual([]);
    const settings = getSettings();
    expect(settings.server).toBe(DEFAULT_SERVER);
    expect(settings.frontend).toBe(DEFAULT_FRONTEND);
    expect(settings.token).toBeNull();
  });
});

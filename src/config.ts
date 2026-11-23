import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Production defaults (override with flags, TUTDUB_* env vars or .env).
 *  The server URL is the client API base: nginx strips the `/api` segment
 *  and Nest serves versioned routes under its global `v1` prefix. */
export const DEFAULT_SERVER = 'https://tutdub.com/api/v1';
export const DEFAULT_FRONTEND = 'https://tutdub.com/app';

export interface Config {
  /** TutDub API base URL, e.g. https://tutdub.com/api/v1 */
  server?: string;
  /** TutDub frontend base URL, e.g. https://tutdub.com/app */
  frontend?: string;
  /** Revocable CLI token (td_cli_...), absent when logged out. */
  token?: string;
  /** Device label the token was issued with. */
  tokenName?: string;
  /** Account email, shown by `whoami` (informational only). */
  email?: string;
}

function configDir(): string {
  const env = process.env;
  // Test/CI escape hatch: point the config anywhere.
  if (env.TUTDUB_CONFIG_HOME) return env.TUTDUB_CONFIG_HOME;
  if (process.platform === 'win32') {
    return join(
      env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
      'tutdub-mcp',
    );
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'tutdub-mcp');
  }
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'tutdub-mcp');
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

export function loadConfig(): Config {
  try {
    const raw = readFileSync(configPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Config) : {};
  } catch {
    return {};
  }
}

export function saveConfig(patch: Partial<Config>): Config {
  const next: Config = { ...loadConfig(), ...patch };
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

/** Resolved settings: flags > environment (incl. .env) > config file > default. */
export interface Settings {
  server: string;
  frontend: string;
  token: string | null;
}

/**
 * Parses a `.env` file body into KEY=VALUE pairs. Supports `export `,
 * single/double quotes and ` #` trailing comments (a `#` glued to the value
 * is kept, so URL fragments survive). Invalid lines are skipped;
 * multi-line values are not supported.
 */
export function parseDotEnv(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    const quote = value[0];
    if (
      (quote === '"' || quote === "'") &&
      value.length > 1 &&
      value.endsWith(quote)
    ) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(' #');
      if (comment >= 0) value = value.slice(0, comment).trimEnd();
    }
    out[key] = value;
  }
  return out;
}

/** Files already processed this process - avoids re-reading on every call. */
const dotEnvLoaded = new Set<string>();

/**
 * Loads a `.env` file into `process.env`, filling only variables that are
 * NOT already set (the real environment always wins - the same rule Bun's
 * own .env loading applies).
 *
 * Without arguments the file is resolved as:
 *   1. `TUTDUB_ENV_FILE` (explicit path - useful for MCP hosts that launch
 *      the server with an unrelated working directory)
 *   2. `.env` in the current working directory
 *
 * Pass `baseDir` to load `<baseDir>/.env` directly instead (used by tests).
 *
 * Called automatically by `getSettings()`; runs at most once per file.
 * Returns the keys that were applied.
 */
export function loadDotEnv(baseDir?: string): string[] {
  const explicit = baseDir ? undefined : process.env.TUTDUB_ENV_FILE?.trim();
  const file = explicit
    ? resolve(explicit)
    : join(baseDir ?? process.cwd(), '.env');
  if (dotEnvLoaded.has(file)) return [];
  dotEnvLoaded.add(file);

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    if (explicit) {
      console.error(
        `Warning: TUTDUB_ENV_FILE points to a missing file: ${file}`,
      );
    }
    return [];
  }

  const applied: string[] = [];
  for (const [key, value] of Object.entries(parseDotEnv(raw))) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

export function getSettings(
  overrides: { server?: string; frontend?: string } = {},
): Settings {
  loadDotEnv(); // .env (TUTDUB_ENV_FILE or cwd) fills unset TUTDUB_* vars
  const cfg = loadConfig();
  const trim = (v: string) => v.replace(/\/+$/, '');
  return {
    server: trim(
      overrides.server ??
        process.env.TUTDUB_SERVER_URL ??
        cfg.server ??
        DEFAULT_SERVER,
    ),
    frontend: trim(
      overrides.frontend ??
        process.env.TUTDUB_FRONTEND_URL ??
        cfg.frontend ??
        DEFAULT_FRONTEND,
    ),
    token: process.env.TUTDUB_TOKEN ?? cfg.token ?? null,
  };
}

/** Throws a friendly error when a command needs auth but none is stored. */
export function requireToken(settings: Settings): string {
  if (!settings.token) {
    throw new Error(
      'Not logged in. Run `tutdub-mcp login` first (or set TUTDUB_TOKEN).',
    );
  }
  return settings.token;
}

export function configExists(): boolean {
  return existsSync(configPath());
}

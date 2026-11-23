#!/usr/bin/env bun
/**
 * tutdub-mcp - CLI + MCP server for the TutDub video dubbing service.
 *
 *   tutdub-mcp login [--server URL] [--frontend URL] [--name DEVICE]
 *   tutdub-mcp logout
 *   tutdub-mcp whoami
 *   tutdub-mcp upload <file> --lang es,fr [--title T] [--source-lang auto]
 *                        [--duration N] [--json]
 *   tutdub-mcp dub <videoId> --lang es,fr
 *   tutdub-mcp status <videoId> [--watch]
 *   tutdub-mcp list
 *   tutdub-mcp download <videoId> [--lang es] [--format video|audio|srt|original]
 *                       [--dest PATH]
 *   tutdub-mcp serve        (run the MCP server on stdio - the default)
 *
 * With no arguments the MCP server starts (stdin/stdout), so MCP hosts can
 * simply launch `tutdub-mcp`.
 */

import { login, logout, whoami } from './auth';
import { getSettings } from './config';
import { serveMcp } from './mcp';
import { contentTypeFor } from './media';
import {
  createContext,
  toolDownload,
  toolGetStatus,
  toolListVideos,
  toolStartDub,
  toolUpload,
} from './tools';

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Minimal argv parser: --flag value, --flag=value, --bool, bare words. */
function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[body] = argv[++i];
      } else {
        flags[body] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function str(flags: ParsedArgs['flags'], name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

function langs(raw: string | undefined, required = true): string[] {
  if (!raw) {
    if (required) fail(`Missing required --lang <code[,code...]>`);
    return [];
  }
  const list = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length && required) fail('Empty --lang list');
  return [...new Set(list)];
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function withStatusWatch(
  videoId: string,
  overrides: { server?: string; frontend?: string } = {},
): Promise<void> {
  const ctx = createContext(overrides);
  const seen = new Set<string>();
  for (;;) {
    const video = await toolGetStatus(ctx, { videoId });
    const lines = video.jobs.map((j) => {
      const mark =
        j.status === 'succeeded'
          ? '✓'
          : j.status === 'failed'
            ? '✗'
            : j.status === 'running'
              ? '▶'
              : '·';
      const err = j.error ? ` - ${j.error}` : '';
      return `  ${mark} ${j.language}: ${j.status} ${j.progress}%${j.stage ? ` (${j.stage})` : ''}${err}`;
    });
    console.error(
      `[${video.status}] ${video.progress}% ${video.title}\n${lines.join('\n')}`,
    );
    if (video.status !== 'processing') {
      if (video.status === 'failed' && video.reason) {
        console.error(`Failed: ${video.reason}`);
      }
      return;
    }
    // Announce newly finished languages once.
    for (const j of video.jobs) {
      if (j.status === 'succeeded' && !seen.has(j.language)) {
        seen.add(j.language);
        console.error(`Language ready: ${j.language}`);
      }
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

const HELP = `tutdub-mcp - TutDub CLI & MCP server (MIT licensed)

Usage:
  tutdub-mcp login [--server URL] [--frontend URL] [--name DEVICE]
      Sign in through the browser form (opens tutdub-frontend).

  tutdub-mcp logout
      Revoke the stored token on the server and clear local credentials.

  tutdub-mcp whoami
      Show the signed-in account.

  tutdub-mcp upload <file> --lang es,fr [--title T] [--source-lang auto]
                           [--duration SECONDS] [--watch] [--json]
      Upload a file and start dubbing. Prints the video id.

  tutdub-mcp dub <videoId> --lang es,fr
      Add target languages to an uploaded video.

  tutdub-mcp status <videoId> [--watch]
      Show processing status (per-language jobs).

  tutdub-mcp list [--json]
      List your videos.

  tutdub-mcp download <videoId> [--lang es] [--format video|audio|srt|original]
                      [--dest PATH]
      Download a result file (default: dubbed video of --lang).

  tutdub-mcp serve
      Run the MCP server on stdio (default when no command is given).

Environment / .env file:
  .env                 Loaded from the directory you run the command in
                       (see .env.example in the package)
  TUTDUB_ENV_FILE      Explicit .env file to load instead
  TUTDUB_SERVER_URL    API base (default https://tutdub.com/api/v1)
  TUTDUB_FRONTEND_URL  Frontend base (default https://tutdub.com/app)
  TUTDUB_TOKEN         Overrides the stored CLI token
  TUTDUB_CONFIG_HOME   Overrides the config directory
  Precedence: flags > environment > .env > config file > defaults
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const { positional, flags } = parseArgs(argv.slice(1));

  if (!command || command === 'serve') {
    await serveMcp();
    return;
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }

  const overrides = {
    server: str(flags, 'server'),
    frontend: str(flags, 'frontend'),
  };

  switch (command) {
    case 'login': {
      await login({
        ...overrides,
        name: str(flags, 'name'),
        noBrowser: flags['no-browser'] === true,
      });
      return;
    }
    case 'logout': {
      await logout();
      return;
    }
    case 'whoami': {
      const settings = getSettings(overrides);
      if (!settings.token) fail('Not logged in. Run `tutdub-mcp login` first.');
      const user = await whoami(settings);
      printJson({ user, server: settings.server });
      return;
    }
    case 'upload': {
      const file = positional[0];
      if (!file) fail('Usage: tutdub-mcp upload <file> --lang es,fr');
      const durationRaw = str(flags, 'duration');
      const duration = durationRaw !== undefined ? Number(durationRaw) : undefined;
      if (duration !== undefined && (!Number.isFinite(duration) || duration < 1)) {
        fail(`--duration must be a positive number of seconds (got "${durationRaw}")`);
      }
      const ctx = createContext(overrides);
      const video = await toolUpload(ctx, {
        path: file,
        languages: langs(str(flags, 'lang')),
        sourceLang: str(flags, 'source-lang'),
        title: str(flags, 'title'),
        duration,
      });
      if (flags['json'] === true) printJson(video);
      else {
        console.log(video.id);
        console.error(
          `Uploaded "${video.title}" (${contentTypeFor(video.fileName)}) - id ${video.id}`,
        );
      }
      if (flags['watch'] === true) await withStatusWatch(video.id, overrides);
      return;
    }
    case 'dub': {
      const videoId = positional[0];
      if (!videoId) fail('Usage: tutdub-mcp dub <videoId> --lang es,fr');
      const ctx = createContext(overrides);
      const result = await toolStartDub(ctx, {
        videoId,
        languages: langs(str(flags, 'lang')),
      });
      if (flags['json'] === true) printJson(result);
      else console.log(result.video.id);
      if (flags['watch'] === true) await withStatusWatch(videoId, overrides);
      return;
    }
    case 'status': {
      const videoId = positional[0];
      if (!videoId) fail('Usage: tutdub-mcp status <videoId>');
      if (flags['watch'] === true) {
        await withStatusWatch(videoId, overrides);
        return;
      }
      const ctx = createContext(overrides);
      const video = await toolGetStatus(ctx, { videoId });
      if (flags['json'] === true) printJson(video);
      else {
        console.log(`${video.status} ${video.progress}% - ${video.title}`);
        for (const j of video.jobs) {
          const err = j.error ? ` - ${j.error}` : '';
          const subs = j.subtitles ? ' [srt]' : '';
          console.log(
            `  ${j.language}: ${j.status} ${j.progress}%${j.stage ? ` (${j.stage})` : ''}${subs}${err}`,
          );
        }
      }
      return;
    }
    case 'list': {
      const ctx = createContext(overrides);
      const videos = await toolListVideos(ctx);
      if (flags['json'] === true) printJson(videos);
      else {
        for (const v of videos) {
          console.log(
            `${v.id}  ${v.status.padEnd(11)} ${String(v.progress).padStart(3)}%  ${v.languages.join(',') || '-'}  ${v.title}`,
          );
        }
      }
      return;
    }
    case 'download': {
      const videoId = positional[0];
      if (!videoId) fail('Usage: tutdub-mcp download <videoId> --lang es');
      const format = (str(flags, 'format') ?? 'video') as
        | 'video'
        | 'audio'
        | 'srt'
        | 'original';
      if (!['video', 'audio', 'srt', 'original'].includes(format)) {
        fail(`Unknown --format "${format}" (video|audio|srt|original)`);
      }
      const ctx = createContext(overrides);
      const result = await toolDownload(ctx, {
        videoId,
        format,
        language: str(flags, 'lang'),
        dest: str(flags, 'dest'),
      });
      if (flags['json'] === true) printJson(result);
      else console.log(result.path);
      return;
    }
    default:
      fail(`Unknown command "${command}". Run \`tutdub-mcp help\`.`);
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});

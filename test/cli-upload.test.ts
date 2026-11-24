/**
 * End-to-end CLI tests for poster (thumbnail) gathering: spawns the real
 * `cli.ts` as a subprocess against a mock server and inspects what the
 * upload start payload carried. Covers the user-facing switches:
 *
 *   - default                      -> capture allowed (result optional, must not fail)
 *   - --no-thumbnail               -> never gathered
 *   - TUTDUB_THUMBNAIL=false       -> never gathered (the persistent CLI setting)
 *   - --thumbnail <img>            -> explicit image wins verbatim
 *
 * Platform capture itself is unit-tested in thumbnail.test.ts; here the OS
 * step may or may not produce anything (CI is Linux), so assertions only
 * rely on what is guaranteed portably.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');
const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

/** Minimal mp4 with a probed duration: ftyp + moov(mvhd v0: 65s). */
function makeMp4(): Buffer {
  const mvhdBody = Buffer.alloc(100);
  mvhdBody[0] = 0; // version 0
  mvhdBody.writeUInt32BE(1000, 12); // timescale
  mvhdBody.writeUInt32BE(65000, 16); // duration
  const mvhdHeader = Buffer.alloc(8);
  mvhdHeader.writeUInt32BE(8 + mvhdBody.length, 0);
  mvhdHeader.write('mvhd', 4, 'latin1');
  const mvhd = Buffer.concat([mvhdHeader, mvhdBody]);

  const moovHeader = Buffer.alloc(8);
  moovHeader.writeUInt32BE(8 + mvhd.length, 0);
  moovHeader.write('moov', 4, 'latin1');
  const moov = Buffer.concat([moovHeader, mvhd]);

  const ftyp = Buffer.alloc(16);
  ftyp.writeUInt32BE(16, 0);
  ftyp.write('ftyp', 4, 'latin1');
  ftyp.write('isom', 8, 'latin1');
  return Buffer.concat([ftyp, moov]);
}

interface MockState {
  started: Record<string, unknown> | null;
  partsReceived: Set<number>;
}

function startMockServer(): { url: string; state: MockState; stop: () => void } {
  const state: MockState = { started: null, partsReceived: new Set() };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      const partMatch = /^\/put-part\/(\d+)$/.exec(url.pathname);
      if (partMatch && req.method === 'PUT') {
        state.partsReceived.add(Number(partMatch[1]));
        await req.arrayBuffer();
        return new Response('');
      }
      if (url.pathname === '/videos/uploads' && req.method === 'POST') {
        state.started = (await req.json()) as Record<string, unknown>;
        return json({
          upload: {
            key: 'uploads/test.mp4',
            uploadId: 'up-1',
            partSize: 8,
            partCount: 2,
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            parts: [1, 2].map((n) => ({
              partNumber: n,
              url: `${url.origin}/put-part/${n}`,
            })),
          },
        });
      }
      if (url.pathname === '/videos/uploads/complete' && req.method === 'POST') {
        if (state.partsReceived.size !== 2) {
          return json({ error: 'Upload is incomplete', code: 'UPLOAD_INCOMPLETE' }, 422);
        }
        return json({
          video: {
            id: 'video-123',
            title: 'sample',
            fileName: 'sample.mp4',
            duration: 65,
            status: 'processing',
            jobs: [],
          },
        });
      }
      if (url.pathname === '/videos/uploads/abort' && req.method === 'POST') {
        return json({ success: true });
      }
      return json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    state,
    stop: () => server.stop(true),
  };
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

describe('CLI poster gathering (end-to-end)', () => {
  let dir: string;
  let mock: ReturnType<typeof startMockServer>;
  let videoPath: string;
  let posterPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tutdub-mcp-cli-'));
    mock = startMockServer();
    videoPath = join(dir, 'video.mp4');
    posterPath = join(dir, 'poster.jpg');
    writeFileSync(videoPath, makeMp4());
    writeFileSync(posterPath, TINY_JPEG);
    // Neutral env file so a developer's local .env never leaks in.
    writeFileSync(join(dir, 'neutral.env'), '');
  });

  afterEach(() => {
    mock.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  async function runCli(
    args: string[],
    env: Record<string, string | undefined> = {},
  ): Promise<CliResult> {
    const spawnEnv: Record<string, string | undefined> = {
      ...process.env,
      TUTDUB_SERVER_URL: mock.url,
      TUTDUB_TOKEN: 'td_cli_test',
      TUTDUB_CONFIG_HOME: join(dir, 'config'),
      TUTDUB_ENV_FILE: join(dir, 'neutral.env'),
    };
    // The developer's own poster setting must never leak into the test.
    delete spawnEnv.TUTDUB_THUMBNAIL;
    for (const [key, value] of Object.entries(env)) spawnEnv[key] = value;

    const proc = Bun.spawn(['bun', join(REPO_ROOT, 'src', 'cli.ts'), ...args], {
      cwd: REPO_ROOT,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: spawnEnv,
      signal: AbortSignal.timeout(30_000),
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited.then(
        (c) => c,
        () => -1,
      ),
    ]);
    return { code, stdout, stderr };
  }

  function startedPayload(): Record<string, unknown> {
    expect(mock.state.started).not.toBeNull();
    return mock.state.started as Record<string, unknown>;
  }

  test('default: capture is allowed and the upload still succeeds', async () => {
    const res = await runCli(['upload', videoPath, '--lang', 'es', '--json']);
    expect(res.code).toBe(0);

    const video = JSON.parse(res.stdout) as { id: string };
    expect(video.id).toBe('video-123');

    // Capture is permitted; the platform may or may not yield a poster
    // (CI is Linux without ffmpegthumbnailer). Whatever is sent must be a
    // valid data URL - the failure mode we must never hit is a crash.
    const thumb = startedPayload().thumbnail;
    expect(thumb === undefined || /^data:image\//.test(String(thumb))).toBe(true);
  }, 40_000);

  test('--no-thumbnail: never gathered', async () => {
    const res = await runCli(['upload', videoPath, '--lang', 'es', '--json', '--no-thumbnail']);
    expect(res.code).toBe(0);
    expect(startedPayload().thumbnail).toBeUndefined();
  }, 40_000);

  test('TUTDUB_THUMBNAIL=false setting: never gathered', async () => {
    const res = await runCli(['upload', videoPath, '--lang', 'es', '--json'], {
      TUTDUB_THUMBNAIL: 'false',
    });
    expect(res.code).toBe(0);
    expect(startedPayload().thumbnail).toBeUndefined();
  }, 40_000);

  test('--thumbnail <img>: the explicit image is sent verbatim', async () => {
    const res = await runCli(['upload', videoPath, '--lang', 'es', '--json', '--thumbnail', posterPath]);
    expect(res.code).toBe(0);
    expect(startedPayload().thumbnail).toBe(
      `data:image/jpeg;base64,${TINY_JPEG.toString('base64')}`,
    );
  }, 40_000);
});

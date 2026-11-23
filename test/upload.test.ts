/**
 * Integration test for the multipart upload flow against a mock server:
 * start -> PUT parts to presigned URLs -> complete, plus abort-on-failure.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadVideo } from '../src/upload';
import { probeDuration } from '../src/media';

function makeWavFile(dir: string, seconds: number): string {
  const byteRate = 176400; // 44.1kHz stereo 16-bit
  const dataSize = byteRate * seconds;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(44100, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(4, 32); // block align
  header.writeUInt16LE(16, 34); // bits
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(dataSize, 40);
  const path = join(dir, 'sample.wav');
  writeFileSync(path, Buffer.concat([header, Buffer.alloc(dataSize)]));
  return path;
}

interface MockState {
  started: Record<string, unknown> | null;
  completed: { key: string; uploadId: string } | null;
  aborted: boolean;
  partsReceived: Set<number>;
}

function startMockUploadServer(): { url: string; state: MockState; stop: () => void } {
  const state: MockState = {
    started: null,
    completed: null,
    aborted: false,
    partsReceived: new Set(),
  };

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      // Presigned part endpoint: /put-part/:n
      const partMatch = /^\/put-part\/(\d+)$/.exec(url.pathname);
      if (partMatch && req.method === 'PUT') {
        state.partsReceived.add(Number(partMatch[1]));
        await req.arrayBuffer(); // drain
        return new Response('');
      }

      if (url.pathname === '/videos/uploads' && req.method === 'POST') {
        state.started = (await req.json()) as Record<string, unknown>;
        const partCount = 2;
        return json({
          upload: {
            key: 'uploads/test.wav',
            uploadId: 'up-1',
            partSize: 8, // tiny parts for the test
            partCount,
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            parts: Array.from({ length: partCount }, (_, i) => ({
              partNumber: i + 1,
              url: `${url.origin}/put-part/${i + 1}`,
            })),
          },
        });
      }

      if (url.pathname === '/videos/uploads/complete' && req.method === 'POST') {
        state.completed = (await req.json()) as { key: string; uploadId: string };
        if (state.partsReceived.size !== 2) {
          return json({ error: 'Upload is incomplete', code: 'UPLOAD_INCOMPLETE' }, 422);
        }
        return json({
          video: {
            id: 'video-123',
            title: 'sample',
            fileName: 'sample.wav',
            status: 'processing',
            jobs: [{ language: 'es', status: 'pending', progress: 0, stage: null, error: null }],
          },
        });
      }

      if (url.pathname === '/videos/uploads/abort' && req.method === 'POST') {
        state.aborted = true;
        return json({ success: true });
      }

      return json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
    },
  });

  return { url: `http://127.0.0.1:${server.port}`, state, stop: () => server.stop(true) };
}

describe('uploadVideo (integration)', () => {
  let dir: string;
  let mock: ReturnType<typeof startMockUploadServer>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tutdub-mcp-up-'));
    mock = startMockUploadServer();
  });

  afterEach(() => {
    mock.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test('probes WAV duration and completes the multipart upload', async () => {
    const file = makeWavFile(dir, 3);
    expect(probeDuration(file)).toBeCloseTo(3, 3);

    const progress: number[] = [];
    const video = await uploadVideo({
      server: mock.url,
      token: 'td_cli_test',
      path: file,
      languages: ['es'],
      onProgress: (pct) => progress.push(pct),
    });

    expect(video.id).toBe('video-123');
    expect(mock.state.completed).toEqual({ key: 'uploads/test.wav', uploadId: 'up-1' });
    expect(mock.state.partsReceived.size).toBe(2);
    expect(mock.state.aborted).toBe(false);

    // Start payload carries what the server needs for pricing/limits.
    const started = mock.state.started as {
      fileName: string;
      duration: number;
      contentType: string;
      languages: string[];
      sourceLang: string;
    };
    expect(started.fileName).toBe('sample.wav');
    expect(started.duration).toBe(3);
    expect(started.contentType).toBe('audio/wav');
    expect(started.languages).toEqual(['es']);
    expect(started.sourceLang).toBe('auto');

    // Progress ends at 100.
    expect(progress.at(-1)).toBe(100);
  });

  test('aborts the session when completion fails', async () => {
    const file = makeWavFile(dir, 1);
    // Sabotage: make part 1 always fail with 403 (non-retryable).
    const origFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/put-part/1') && init?.method === 'PUT') {
        return Promise.resolve(new Response('forbidden', { status: 403 }));
      }
      return origFetch(input as never, init);
    }) as typeof fetch;

    try {
      await expect(
        uploadVideo({
          server: mock.url,
          token: 'td_cli_test',
          path: file,
          languages: ['es'],
        }),
      ).rejects.toThrow();
    } finally {
      globalThis.fetch = origFetch;
    }

    expect(mock.state.aborted).toBe(true);
    expect(mock.state.completed).toBeNull();
  }, 30_000);

  test('fails with a clear message when duration cannot be probed', async () => {
    const file = join(dir, 'mystery.webm');
    writeFileSync(file, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]));
    await expect(
      uploadVideo({
        server: mock.url,
        token: 'td_cli_test',
        path: file,
        languages: ['es'],
      }),
    ).rejects.toThrow(/--duration/);
    // Never reached the server.
    expect(mock.state.started).toBeNull();
  });
});

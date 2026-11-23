import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentTypeFor, probeDuration } from '../src/media';
import { variantFor } from '../src/download';
import { ApiError, apiRequest } from '../src/api';

describe('contentTypeFor', () => {
  test('maps common extensions', () => {
    expect(contentTypeFor('lesson.mp4')).toBe('video/mp4');
    expect(contentTypeFor('clip.MOV')).toBe('video/quicktime');
    expect(contentTypeFor('track.mp3')).toBe('audio/mpeg');
    expect(contentTypeFor('song.wav')).toBe('audio/wav');
  });
  test('falls back for unknown extensions', () => {
    expect(contentTypeFor('weird.xyz')).toBe('application/octet-stream');
    expect(contentTypeFor('noext')).toBe('application/octet-stream');
  });
});

describe('variantFor', () => {
  test('maps formats to server variants', () => {
    expect(variantFor('video', 'de')).toBe('de');
    expect(variantFor('audio', 'de')).toBe('de-audio');
    expect(variantFor('srt', 'de')).toBe('de-srt');
    expect(variantFor('original')).toBe('original');
  });
  test('requires a language for language-scoped formats', () => {
    expect(() => variantFor('video')).toThrow(/language/i);
    expect(() => variantFor('srt')).toThrow(/language/i);
    expect(() => variantFor('original')).not.toThrow();
  });
});

describe('probeDuration', () => {
  let dir: string;

  const makeWav = (byteRate: number, dataSize: number): Buffer => {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'latin1');
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8, 'latin1');
    header.write('fmt ', 12, 'latin1');
    header.writeUInt32LE(16, 16); // fmt chunk size
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(2, 22); // channels
    header.writeUInt32LE(44100, 24); // sample rate
    header.writeUInt32LE(byteRate, 28); // byte rate
    header.write('data', 36, 'latin1');
    header.writeUInt32LE(dataSize, 40);
    return header;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tutdub-mcp-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('probes WAV duration from byte rate', () => {
    const path = join(dir, 'test.wav');
    // 44100*2*2 = 176400 byte/s -> 43200 bytes = 0.25s? use 1764000 bytes = 10s
    writeFileSync(path, makeWav(176400, 1764000));
    const duration = probeDuration(path);
    expect(duration).not.toBeNull();
    expect(duration!).toBeCloseTo(10, 3);
  });

  test('returns null for unknown containers', () => {
    const path = join(dir, 'test.webm');
    writeFileSync(path, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]));
    expect(probeDuration(path)).toBeNull();
  });

  test('returns null for empty files', () => {
    const path = join(dir, 'empty.mp4');
    writeFileSync(path, Buffer.alloc(0));
    expect(probeDuration(path)).toBeNull();
  });

  test('probes ISO-BMFF mvhd (v0)', () => {
    // Build: ftyp box + moov(mvhd v0: timescale 1000, duration 65000 -> 65s)
    const mvhdBody = Buffer.alloc(100);
    mvhdBody[0] = 0; // version 0
    mvhdBody.writeUInt32BE(1000, 12); // timescale
    mvhdBody.writeUInt32BE(65000, 16); // duration
    const mvhd = Buffer.concat([
      (() => {
        const h = Buffer.alloc(8);
        h.writeUInt32BE(8 + mvhdBody.length, 0);
        h.write('mvhd', 4, 'latin1');
        return h;
      })(),
      mvhdBody,
    ]);
    const moov = Buffer.concat([
      (() => {
        const h = Buffer.alloc(8);
        h.writeUInt32BE(8 + mvhd.length, 0);
        h.write('moov', 4, 'latin1');
        return h;
      })(),
      mvhd,
    ]);
    const ftyp = Buffer.alloc(16);
    ftyp.writeUInt32BE(16, 0);
    ftyp.write('ftyp', 4, 'latin1');
    ftyp.write('isom', 8, 'latin1');
    const path = join(dir, 'test.mp4');
    writeFileSync(path, Buffer.concat([ftyp, moov]));
    const duration = probeDuration(path);
    expect(duration).not.toBeNull();
    expect(duration!).toBeCloseTo(65, 5);
  });
});

describe('apiRequest', () => {
  test('throws ApiError with server message and code', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({ error: 'Not enough credits', code: 'INSUFFICIENT_CREDITS' }),
          { status: 402, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    try {
      const err = await apiRequest(
        `http://127.0.0.1:${server.port}`,
        '/videos',
        { token: 'td_cli_x' },
      ).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(402);
      expect(apiErr.code).toBe('INSUFFICIENT_CREDITS');
      expect(apiErr.message).toBe('Not enough credits');
    } finally {
      server.stop(true);
    }
  });

  test('wraps network failures as ApiError with status 0', async () => {
    const err = await apiRequest('http://127.0.0.1:1', '/nothing').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(0);
    expect(apiErr.code).toBe('NETWORK');
  });

  test('sends auth header and query params', async () => {
    const seen: { auth: string | null; query: string | null } = {
      auth: null,
      query: null,
    };
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seen.auth = req.headers.get('authorization');
        seen.query = url.searchParams.get('variant');
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    try {
      const result = await apiRequest<{ ok: boolean }>(
        `http://127.0.0.1:${server.port}`,
        '/videos/x/files',
        { token: 'td_cli_abc', query: { variant: 'de-srt' } },
      );
      expect(result.ok).toBe(true);
      expect(seen.auth).toBe('Bearer td_cli_abc');
      expect(seen.query).toBe('de-srt');
    } finally {
      server.stop(true);
    }
  });
});

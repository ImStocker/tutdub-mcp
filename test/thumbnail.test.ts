/**
 * Poster thumbnail capture tests: embedded cover-art parsing (ISO-BMFF
 * `covr` boxes), the OS-capture seam, data-URL budget enforcement, and
 * validation of explicitly supplied images. No OS helper is ever spawned
 * here - the platform step is injected through the `osCapture` seam.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeCoverArt } from '../src/media';
import {
  captureThumbnail,
  imageFileToDataUrl,
  MAX_THUMBNAIL_BYTES,
} from '../src/thumbnail';

/** A few bytes that sniff as JPEG (FF D8 FF ...). */
const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function box(type: string, ...children: Buffer[]): Buffer {
  const body = Buffer.concat(children);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}

function ftyp(): Buffer {
  return box('ftyp', Buffer.from('isom', 'latin1'), Buffer.alloc(4), Buffer.from('isom', 'latin1'));
}

/** ilst `data` box: 4B flags (13 = JPEG) + 4B locale + payload. */
function dataBox(flags: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(flags, 0);
  return box('data', head, payload);
}

/** Builds `ftyp + moov > [udta >] meta > ilst > covr > data` around an image. */
function mp4WithCover(image: Buffer, flags: number, opts: { withUdta: boolean }): Buffer {
  const covr = box('covr', dataBox(flags, image));
  const ilst = box('ilst', covr);
  const meta = box('meta', Buffer.alloc(4), ilst); // FullBox: version+flags
  const udta = box('udta', meta);
  const moov = box('moov', opts.withUdta ? udta : meta);
  return Buffer.concat([ftyp(), moov]);
}

function mp4WithoutCover(): Buffer {
  return Buffer.concat([ftyp(), box('moov', Buffer.alloc(100))]);
}

describe('probeCoverArt', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tutdub-mcp-cover-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('extracts the JPEG payload from moov > udta > meta > ilst > covr', () => {
    const path = join(dir, 'covered.mp4');
    writeFileSync(path, mp4WithCover(TINY_JPEG, 13, { withUdta: true }));

    const cover = probeCoverArt(path);
    expect(cover).not.toBeNull();
    expect(cover!.mime).toBe('image/jpeg');
    expect(Buffer.compare(cover!.bytes, TINY_JPEG)).toBe(0);
  });

  test('handles the moov > meta path (no udta) and PNG payloads', () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(16),
    ]);
    const path = join(dir, 'no-udta.mp4');
    writeFileSync(path, mp4WithCover(png, 14, { withUdta: false }));

    const cover = probeCoverArt(path);
    expect(cover).not.toBeNull();
    expect(cover!.mime).toBe('image/png');
    expect(Buffer.compare(cover!.bytes, png)).toBe(0);
  });

  test('returns null for files without cover art', () => {
    const path = join(dir, 'plain.mp4');
    writeFileSync(path, mp4WithoutCover());
    expect(probeCoverArt(path)).toBeNull();
  });

  test('returns null for unsupported extensions (audio) and missing files', () => {
    const mp3 = join(dir, 'track.mp3');
    writeFileSync(mp3, Buffer.from('ID3'));
    expect(probeCoverArt(mp3)).toBeNull();
    expect(probeCoverArt(join(dir, 'gone.mp4'))).toBeNull();
  });

  test('skips cover art larger than the data-URL budget', () => {
    const path = join(dir, 'huge.mp4');
    writeFileSync(path, mp4WithCover(Buffer.alloc(400_000, 0xff), 13, { withUdta: true }));
    expect(probeCoverArt(path)).toBeNull();
  });
});

describe('captureThumbnail', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tutdub-mcp-thumb-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('never probes OS thumbnails for audio files', async () => {
    let called = 0;
    const result = await captureThumbnail(join(dir, 'song.mp3'), {
      osCapture: async () => {
        called++;
        return { bytes: TINY_JPEG, mime: 'image/jpeg', source: 'shell' };
      },
    });
    expect(result).toBeNull();
    expect(called).toBe(0);
  });

  test('returns the OS capture as a data URL when available', async () => {
    const path = join(dir, 'video.mp4');
    writeFileSync(path, mp4WithoutCover());

    const result = await captureThumbnail(path, {
      osCapture: async () => ({ bytes: TINY_JPEG, mime: 'image/jpeg', source: 'shell' }),
    });
    expect(result).not.toBeNull();
    expect(result!.source).toBe('shell');
    expect(result!.dataUrl).toBe(`data:image/jpeg;base64,${TINY_JPEG.toString('base64')}`);
    expect(result!.bytes).toBe(TINY_JPEG.length);
  });

  test('falls back to embedded cover art when the OS step yields nothing', async () => {
    const path = join(dir, 'covered.mp4');
    writeFileSync(path, mp4WithCover(TINY_JPEG, 13, { withUdta: true }));

    const result = await captureThumbnail(path, { osCapture: async () => null });
    expect(result).not.toBeNull();
    expect(result!.source).toBe('cover-art');
    expect(result!.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  test('osCapture: null skips the OS step but keeps the cover-art fallback', async () => {
    const path = join(dir, 'covered.mp4');
    writeFileSync(path, mp4WithCover(TINY_JPEG, 13, { withUdta: true }));

    const result = await captureThumbnail(path, { osCapture: null });
    expect(result!.source).toBe('cover-art');
  });

  test('returns null when the OS step fails and no cover art exists', async () => {
    const path = join(dir, 'plain.mp4');
    writeFileSync(path, mp4WithoutCover());

    const boom = await captureThumbnail(path, {
      osCapture: async () => {
        throw new Error('no shell available');
      },
    });
    expect(boom).toBeNull();
  });

  test('drops captures whose data URL exceeds the server limit', async () => {
    const path = join(dir, 'video.mp4');
    writeFileSync(path, mp4WithoutCover());

    const oversized = Buffer.alloc(600_000, 0xff); // -> >512KB data URL
    const result = await captureThumbnail(path, {
      osCapture: async () => ({ bytes: oversized, mime: 'image/jpeg', source: 'shell' }),
    });
    expect(result).toBeNull();
  });
});

describe('imageFileToDataUrl', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tutdub-mcp-img-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('wraps a jpg into a data URL', () => {
    const path = join(dir, 'poster.jpg');
    writeFileSync(path, TINY_JPEG);
    expect(imageFileToDataUrl(path)).toBe(
      `data:image/jpeg;base64,${TINY_JPEG.toString('base64')}`,
    );
  });

  test('maps png to image/png', () => {
    const path = join(dir, 'poster.png');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(path, png);
    expect(imageFileToDataUrl(path).startsWith('data:image/png;base64,')).toBe(true);
  });

  test('rejects unsupported extensions', () => {
    const path = join(dir, 'poster.txt');
    writeFileSync(path, 'not an image');
    expect(() => imageFileToDataUrl(path)).toThrow(/Unsupported thumbnail image/);
  });

  test('rejects images that would exceed the server limit', () => {
    const path = join(dir, 'big.jpg');
    writeFileSync(path, Buffer.alloc(MAX_THUMBNAIL_BYTES, 0xff)); // base64 inflates by 33%
    expect(() => imageFileToDataUrl(path)).toThrow(/too large/);
  });

  test('rejects an empty image', () => {
    const path = join(dir, 'empty.jpg');
    writeFileSync(path, Buffer.alloc(0));
    expect(() => imageFileToDataUrl(path)).toThrow(/empty/);
  });

  test('reports a readable error for a missing file', () => {
    expect(() => imageFileToDataUrl(join(dir, 'gone.jpg'))).toThrow(/Cannot read/);
  });
});

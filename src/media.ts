/**
 * Best-effort media metadata probing without ffmpeg.
 *
 * The server requires a duration (>= 1s) at upload start: it drives pricing
 * (credits = ceil(minutes) per language) and plan limits. We probe the most
 * common containers exactly and fall back to a clear error asking for
 * `--duration` when the container is unknown.
 *
 * The same box walk also pulls embedded cover art (`covr`) out of ISO-BMFF
 * files - a free poster image for uploads when the file carries one.
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs';

const EXT_CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
};

export function contentTypeFor(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
  return EXT_CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

export function isAudioContentType(contentType: string): boolean {
  return contentType.startsWith('audio/');
}

/** Reads `length` bytes at `position`; returns null on short read. */
function readAt(fd: number, position: number, length: number): Buffer | null {
  const buf = Buffer.alloc(length);
  const got = readSync(fd, buf, 0, length, position);
  return got === length ? buf : got > 0 ? buf.subarray(0, got) : null;
}

/**
 * Probes duration in seconds. Returns null when the container is not
 * supported - callers should then require an explicit `--duration`.
 */
export function probeDuration(filePath: string): number | null {
  const stat = statSync(filePath);
  if (stat.size === 0) return null;
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    switch (ext) {
      case '.mp4':
      case '.m4v':
      case '.mov':
      case '.m4a':
        return probeIsoBmff(fd, stat.size);
      case '.wav':
        return probeWav(fd, stat.size);
      case '.mp3':
        return probeMp3(fd, stat.size);
      default:
        return null;
    }
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// ------------------------------------------------------- ISO-BMFF (mp4 family)

function probeIsoBmff(fd: number, fileSize: number): number | null {
  let offset = 0;
  // Scan top-level boxes for `moov` (it may trail a large `mdat`).
  while (offset + 8 <= fileSize) {
    const header = readAt(fd, offset, 16);
    if (!header || header.length < 8) return null;
    let size = header.readUInt32BE(0);
    const type = header.toString('latin1', 4, 8);
    let headerSize = 8;
    if (size === 1) {
      if (header.length < 16) return null;
      const big = header.readBigUInt64BE(8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(big);
      headerSize = 16;
    } else if (size === 0) {
      size = fileSize - offset; // box extends to EOF
    }
    if (size < headerSize) return null;
    if (type === 'moov') return probeMoov(fd, offset + headerSize, size - headerSize);
    offset += size;
  }
  return null;
}

function probeMoov(fd: number, start: number, length: number): number | null {
  let offset = start;
  const end = start + length;
  while (offset + 8 <= end) {
    const header = readAt(fd, offset, 16);
    if (!header || header.length < 8) return null;
    let size = header.readUInt32BE(0);
    const type = header.toString('latin1', 4, 8);
    let headerSize = 8;
    if (size === 1) {
      if (header.length < 16) return null;
      size = Number(header.readBigUInt64BE(8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize) return null;
    if (type === 'mvhd') {
      const body = readAt(fd, offset + headerSize, size - headerSize);
      if (!body || body.length < 12) return null;
      const version = body[0];
      let timescale: number;
      let duration: number;
      if (version === 1) {
        if (body.length < 32) return null;
        timescale = body.readUInt32BE(20);
        duration = Number(body.readBigUInt64BE(24));
      } else {
        if (body.length < 20) return null;
        timescale = body.readUInt32BE(12);
        duration = body.readUInt32BE(16);
      }
      if (timescale > 0 && duration > 0 && duration !== 0xffffffff) {
        return duration / timescale;
      }
      return null;
    }
    offset += size;
  }
  return null;
}

// ------------------------------------------------------------------- WAV

function probeWav(fd: number, fileSize: number): number | null {
  const head = readAt(fd, 0, 12);
  if (!head || head.length < 12) return null;
  if (head.toString('latin1', 0, 4) !== 'RIFF') return null;
  if (head.toString('latin1', 8, 12) !== 'WAVE') return null;

  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= fileSize) {
    const header = readAt(fd, offset, 8);
    if (!header || header.length < 8) return null;
    const id = header.toString('latin1', 0, 4);
    const size = header.readUInt32LE(4);
    if (id === 'fmt ') {
      const fmt = readAt(fd, offset + 8, Math.min(size, 16));
      if (!fmt || fmt.length < 16) return null;
      byteRate = fmt.readUInt32LE(8);
    } else if (id === 'data') {
      if (byteRate > 0) return size / byteRate;
      return null;
    }
    // Chunks are word-aligned.
    offset += 8 + size + (size % 2);
  }
  return null;
}

// ------------------------------------------------------------------- MP3

/** MPEG-1 Layer III bitrates (kbps), index 1..14. */
const MP3_BITRATES_V1_L3 = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];
/** MPEG-2/2.5 Layer III bitrates (kbps). */
const MP3_BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

function probeMp3(fd: number, fileSize: number): number | null {
  let offset = 0;
  const head = readAt(fd, 0, 10);
  if (head && head.length === 10 && head.toString('latin1', 0, 3) === 'ID3') {
    // Syncsafe 28-bit tag size.
    const size =
      ((head[6] & 0x7f) << 21) |
      ((head[7] & 0x7f) << 14) |
      ((head[8] & 0x7f) << 7) |
      (head[9] & 0x7f);
    offset = 10 + size;
  }

  // Find the first frame header.
  const window = readAt(fd, offset, 65536);
  if (!window) return null;
  let framePos = -1;
  for (let i = 0; i + 4 <= window.length; i++) {
    if (window[i] === 0xff && (window[i + 1] & 0xe0) === 0xe0) {
      framePos = i;
      break;
    }
  }
  if (framePos < 0) return null;

  const b1 = window[framePos + 1];
  const b2 = window[framePos + 2];
  const versionBits = (b1 >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layerBits = (b1 >> 1) & 0x03; // 1=Layer III
  const bitrateIndex = (b2 >> 4) & 0x0f;
  if (versionBits === 1 || layerBits !== 1) return null; // reserved / not L3
  if (bitrateIndex === 0 || bitrateIndex === 15) return null;

  const isMpeg1 = versionBits === 3;
  const kbps = isMpeg1
    ? MP3_BITRATES_V1_L3[bitrateIndex]
    : MP3_BITRATES_V2_L3[bitrateIndex];
  if (!kbps) return null;

  // CBR estimate over the remaining audio bytes; close enough for pricing
  // (cost is per whole minute) and plan limits.
  const audioBytes = fileSize - offset;
  return (audioBytes * 8) / (kbps * 1000);
}

// ------------------------------------------------------- embedded cover art

export interface CoverArt {
  bytes: Buffer;
  mime: string;
}

/**
 * Raw cover bytes are capped well below the server's 512 KiB data-URL
 * limit (base64 adds ~33%): anything larger is skipped instead of sent.
 */
const MAX_COVER_BYTES = 380_000;

interface BoxRange {
  type: string;
  /** Offset of the first byte after the box header. */
  bodyStart: number;
  /** Offset of the first byte after the box (start of the next box). */
  end: number;
}

/** Parses an ISO-BMFF box header at `offset`; null when malformed/truncated. */
function readBoxHeader(fd: number, offset: number, end: number): BoxRange | null {
  const header = readAt(fd, offset, 16);
  if (!header || header.length < 8) return null;
  let size = header.readUInt32BE(0);
  const type = header.toString('latin1', 4, 8);
  let headerSize = 8;
  if (size === 1) {
    if (header.length < 16) return null;
    const big = header.readBigUInt64BE(8);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(big);
    headerSize = 16;
  } else if (size === 0) {
    size = end - offset; // box extends to the end of its container
  }
  if (size < headerSize || offset + size > end) return null;
  return { type, bodyStart: offset + headerSize, end: offset + size };
}

/** Finds a direct child box by fourcc within [start, end). */
function findChildBox(fd: number, start: number, end: number, type: string): BoxRange | null {
  let offset = start;
  while (offset + 8 <= end) {
    const box = readBoxHeader(fd, offset, end);
    if (!box) return null;
    if (box.type === type) return box;
    offset = box.end;
  }
  return null;
}

/** Sniffs the payload of an ilst `data` box into a mime type. */
function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes.toString('latin1', 1, 4) === 'PNG'
  ) {
    return 'image/png';
  }
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' &&
      bytes.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  const gif = bytes.toString('latin1', 0, 6);
  if (bytes.length >= 6 && (gif === 'GIF87a' || gif === 'GIF89a')) return 'image/gif';
  return null;
}

/**
 * Extracts embedded cover art from an ISO-BMFF file
 * (`moov > udta > meta > ilst > covr`, with `moov > meta` as a fallback
 * path used by some muxers). Returns null for audio-only extensions,
 * files without artwork, or anything larger than the server accepts.
 */
export function probeCoverArt(filePath: string): CoverArt | null {
  let fd: number | null = null;
  try {
    const stat = statSync(filePath);
    if (stat.size === 0) return null;
    fd = openSync(filePath, 'r');
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    if (!['.mp4', '.m4v', '.mov', '.m4a'].includes(ext)) return null;

    const paths = [
      ['moov', 'udta', 'meta', 'ilst', 'covr'],
      ['moov', 'meta', 'ilst', 'covr'],
    ];
    for (const path of paths) {
      let node = findChildBox(fd, 0, stat.size, path[0]);
      if (!node) continue;
      for (const name of path.slice(1)) {
        // Descend into `node`: `meta` is a FullBox (version+flags first),
        // so its child boxes start 4 bytes later.
        const start = node.type === 'meta' ? node.bodyStart + 4 : node.bodyStart;
        node = findChildBox(fd, start, node.end, name);
        if (!node) break;
      }
      if (!node) continue;

      // The covr box holds one or more `data` boxes:
      //   4 bytes version+flags (low 24 bits: 13=JPEG, 14=PNG),
      //   4 bytes locale, then the image payload.
      const data = findChildBox(fd, node.bodyStart, node.end, 'data');
      if (!data) continue;
      const payloadStart = data.bodyStart + 8;
      const length = data.end - payloadStart;
      if (length <= 0 || length > MAX_COVER_BYTES) continue;
      const bytes = readAt(fd, payloadStart, length);
      if (!bytes) continue;
      const mime = sniffImageMime(bytes);
      if (!mime) continue;
      return { bytes, mime };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Best-effort media metadata probing without ffmpeg.
 *
 * The server requires a duration (>= 1s) at upload start: it drives pricing
 * (credits = ceil(minutes) per language) and plan limits. We probe the most
 * common containers exactly and fall back to a clear error asking for
 * `--duration` when the container is unknown.
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

/**
 * Direct-to-S3 multipart upload, mirroring the frontend uploader:
 * start session -> PUT presigned parts (3 in parallel, with retry) -> complete.
 */

import { statSync } from 'node:fs';
import { basename } from 'node:path';
import {
  apiRequest,
  ApiError,
  type UploadOptions,
  type UploadSession,
  type Video,
} from './api';
import { contentTypeFor, isAudioContentType, probeDuration } from './media';
import { captureThumbnail, MAX_THUMBNAIL_BYTES } from './thumbnail';

const CONCURRENCY = 3;
const PART_RETRIES = 3;

export interface UploadInput {
  server: string;
  token: string;
  /** Absolute or relative path of the media file. */
  path: string;
  /** Target language codes, e.g. ['es', 'fr']. */
  languages: string[];
  /** Source language code or 'auto' (default). */
  sourceLang?: string;
  /** Overrides the file basename. */
  title?: string;
  /** Overrides the probed duration (seconds). */
  duration?: number;
  /**
   * Poster data URL for the server. `undefined` (default) auto-captures
   * one from the OS/cover art for video files, `null` skips the capture,
   * a string is used as-is (validated against the server limit).
   */
  thumbnail?: string | null;
  options?: UploadOptions;
  onProgress?: (percent: number) => void;
  /** Informational sink (poster source/size, ...). */
  onInfo?: (line: string) => void;
}

async function putPart(url: string, body: Blob): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PART_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { method: 'PUT', body });
      if (res.ok) return;
      // 4xx (except 429) will not succeed on retry.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new ApiError(`Upload part rejected (${res.status})`, res.status);
      }
      lastError = new ApiError(`Upload part failed (${res.status})`, res.status);
    } catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        throw err;
      }
      lastError = err;
    }
    if (attempt < PART_RETRIES) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Upload part failed');
}

/** Validates an explicitly supplied poster against the server rules. */
function validateExplicitThumbnail(value: string): string {
  if (!value.startsWith('data:image/')) {
    throw new Error(
      `thumbnail must be a data:image/... URL (got "${value.slice(0, 40)}...")`,
    );
  }
  if (value.length > MAX_THUMBNAIL_BYTES) {
    throw new Error(
      `thumbnail is too large (${value.length} bytes; the server accepts ` +
        `at most ${MAX_THUMBNAIL_BYTES})`,
    );
  }
  return value;
}

/**
 * Resolves the poster for the start payload. Auto-capture is best-effort
 * (returns null on any failure) and only runs for non-audio files; an
 * explicit value is user input, so it is validated and may throw.
 */
async function resolveThumbnail(
  input: UploadInput,
  contentType: string,
): Promise<string | null> {
  if (input.thumbnail === null) return null; // explicitly skipped
  if (input.thumbnail !== undefined) return validateExplicitThumbnail(input.thumbnail);
  if (isAudioContentType(contentType)) return null;
  const captured = await captureThumbnail(input.path);
  if (!captured) return null;
  input.onInfo?.(
    `thumbnail: ${captured.bytes} bytes via ${captured.source}`,
  );
  return captured.dataUrl;
}

/**
 * Uploads the file and completes the session, returning the created video.
 * Aborts the session on failure so no orphaned parts linger in S3.
 */
export async function uploadVideo(input: UploadInput): Promise<Video> {
  const stat = statSync(input.path);
  if (stat.size <= 0) {
    throw new Error(`File is empty: ${input.path}`);
  }
  const fileName = basename(input.path);
  const contentType = contentTypeFor(fileName);

  const duration =
    input.duration ?? Math.ceil(probeDuration(input.path) ?? 0);
  if (!duration || duration < 1) {
    throw new Error(
      `Could not detect the duration of ${fileName}. ` +
        'Pass --duration <seconds> explicitly.',
    );
  }

  // Poster capture runs after the cheap duration validation so a bad file
  // never pays for an OS thumbnail spawn.
  const thumbnail = await resolveThumbnail(input, contentType);

  const { upload } = await apiRequest<{ upload: UploadSession }>(
    input.server,
    '/videos/uploads',
    {
      method: 'POST',
      token: input.token,
      body: {
        fileName,
        fileSize: stat.size,
        contentType,
        title: input.title || undefined,
        duration,
        sourceLang: input.sourceLang || 'auto',
        languages: input.languages,
        options: input.options ?? {},
        ...(thumbnail ? { thumbnail } : {}),
      },
    },
  );

  try {
    const { parts, partSize } = upload;
    const done = new Array<number>(parts.length).fill(0);
    let loaded = 0;
    let nextIndex = 0;
    const report = () => {
      input.onProgress?.(Math.min(100, Math.round((loaded / stat.size) * 100)));
    };
    report();

    const worker = async (): Promise<void> => {
      while (nextIndex < parts.length) {
        const i = nextIndex++;
        const start = i * partSize;
        const end = Math.min(start + partSize, stat.size);
        const buf = await Bun.file(input.path).slice(start, end).arrayBuffer();
        await putPart(parts[i].url, new Blob([buf]));
        loaded += end - start - done[i];
        done[i] = end - start;
        report();
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, parts.length) }, worker),
    );
    loaded = stat.size;
    report();

    const { video } = await apiRequest<{ video: Video }>(
      input.server,
      '/videos/uploads/complete',
      {
        method: 'POST',
        token: input.token,
        body: { key: upload.key, uploadId: upload.uploadId },
      },
    );
    return video;
  } catch (err) {
    // Best-effort cleanup; the session also expires server-side on its own.
    await apiRequest(input.server, '/videos/uploads/abort', {
      method: 'POST',
      token: input.token,
      body: { key: upload.key, uploadId: upload.uploadId },
    }).catch(() => undefined);
    throw err;
  }
}

/**
 * Download results by variant:
 *   <lang>        dubbed video (or audio result for audio uploads)
 *   <lang>-audio  extracted audio track (video uploads only)
 *   <lang>-srt    subtitles (when the worker produced them)
 *   original      the uploaded source file
 */

import { mkdirSync, statSync } from 'node:fs';
import { dirname, join, basename as pathBasename } from 'node:path';
import { apiRequest } from './api';

export type DownloadFormat = 'video' | 'audio' | 'srt' | 'original';

/** Maps a friendly format + language to the server's `variant` value. */
export function variantFor(format: DownloadFormat, language?: string): string {
  if (format === 'original') return 'original';
  if (!language) {
    throw new Error(`A language is required for format "${format}"`);
  }
  return format === 'video'
    ? language
    : format === 'audio'
      ? `${language}-audio`
      : `${language}-srt`;
}

export interface DownloadResult {
  url: string;
  /** Resolved local path the file was written to. */
  path: string;
  bytes: number;
}

/**
 * Resolves a presigned URL for the variant and streams it to `dest`
 * (a file path, or a directory -> filename comes from Content-Disposition
 * or a generated fallback). Defaults to ./<filename>.
 */
export async function downloadResult(opts: {
  server: string;
  token: string;
  videoId: string;
  variant: string;
  dest?: string;
}): Promise<DownloadResult> {
  const { url } = await apiRequest<{ url: string }>(
    opts.server,
    `/videos/${encodeURIComponent(opts.videoId)}/files`,
    {
      query: { variant: opts.variant, download: 1 },
      token: opts.token,
    },
  );

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed (${res.status} ${res.statusText})`);
  }

  const suggested =
    filenameFromDisposition(res.headers.get('content-disposition')) ??
    `${opts.videoId}-${opts.variant}.${extForVariant(opts.variant)}`;

  // No dest -> cwd with the suggested name. Dest with a dot in the last
  // segment -> treat as a file path; otherwise treat it as a directory.
  let finalPath: string;
  if (!opts.dest) {
    finalPath = join(process.cwd(), suggested);
  } else {
    const looksLikeFile =
      pathBasename(opts.dest).includes('.') &&
      !opts.dest.endsWith('/') &&
      !opts.dest.endsWith('\\');
    finalPath = looksLikeFile ? opts.dest : join(opts.dest, suggested);
  }

  mkdirSync(dirname(finalPath), { recursive: true });
  await Bun.write(finalPath, res);
  return { url, path: finalPath, bytes: statSync(finalPath).size };
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const match = /filename="?([^";]+)"?/i.exec(header);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function extForVariant(variant: string): string {
  if (variant.endsWith('-srt')) return 'srt';
  if (variant.endsWith('-audio')) return 'mp3';
  return 'mp4';
}

/**
 * MCP tool implementations shared by the stdio server and the CLI.
 * Every tool returns a JSON-serializable payload; errors bubble up as
 * ApiError/Error and are rendered by the caller.
 */

import { apiRequest, type Video, type UploadOptions } from './api';
import { getSettings, requireToken, type Settings } from './config';
import { uploadVideo, type UploadInput } from './upload';
import { downloadResult, variantFor, type DownloadFormat } from './download';

export interface ToolContext {
  settings: Settings;
  /** Progress sink (CLI prints it, MCP logs to stderr). */
  log?: (line: string) => void;
}

export function createContext(overrides: {
  server?: string;
  frontend?: string;
}): ToolContext {
  return { settings: getSettings(overrides) };
}

function auth(ctx: ToolContext): { server: string; token: string } {
  return { server: ctx.settings.server, token: requireToken(ctx.settings) };
}

// ------------------------------------------------------------------ upload

export interface UploadArgs {
  path: string;
  languages: string[];
  sourceLang?: string;
  title?: string;
  duration?: number;
  options?: UploadOptions & {
    /**
     * UI-semantics flag (default on): "adapt the audio timeline to the
     * dub". The server/worker flag means the opposite, so it is inverted
     * here exactly like the frontend does at submit time.
     */
    adaptAudioTimeline?: boolean;
  };
}

export async function toolUpload(
  ctx: ToolContext,
  args: UploadArgs,
): Promise<Video> {
  const { server, token } = auth(ctx);
  const { adaptAudioTimeline, ...rest } = args.options ?? {};
  const options: UploadOptions = {
    ...rest,
    adaptTimingAudio: adaptAudioTimeline === undefined ? undefined : !adaptAudioTimeline,
  };
  const input: UploadInput = {
    server,
    token,
    path: args.path,
    languages: args.languages,
    sourceLang: args.sourceLang,
    title: args.title,
    duration: args.duration,
    options,
    onProgress: (pct) => ctx.log?.(`upload: ${pct}%`),
  };
  return uploadVideo(input);
}

// --------------------------------------------------------------- dubbing

/** Adds target languages to an existing video (server: reprocess). */
export async function toolStartDub(
  ctx: ToolContext,
  args: { videoId: string; languages: string[] },
): Promise<{ success: boolean; video: Video }> {
  const { server, token } = auth(ctx);
  return apiRequest<{ success: boolean; video: Video }>(
    server,
    `/videos/${encodeURIComponent(args.videoId)}/reprocess`,
    { method: 'POST', token, body: { languages: args.languages } },
  );
}

// ---------------------------------------------------------------- status

export async function toolGetStatus(
  ctx: ToolContext,
  args: { videoId: string },
): Promise<Video> {
  const { server, token } = auth(ctx);
  const { status } = await apiRequest<{ status: Video }>(
    server,
    `/videos/${encodeURIComponent(args.videoId)}/status`,
    { token },
  );
  return status;
}

export async function toolListVideos(ctx: ToolContext): Promise<Video[]> {
  const { server, token } = auth(ctx);
  const { videos } = await apiRequest<{ videos: Video[] }>(server, '/videos', {
    token,
  });
  return videos;
}

// -------------------------------------------------------------- download

export interface DownloadArgs {
  videoId: string;
  format?: DownloadFormat;
  language?: string;
  /** File path or directory; defaults to the current directory. */
  dest?: string;
}

export async function toolDownload(
  ctx: ToolContext,
  args: DownloadArgs,
): Promise<{ path: string; bytes: number; variant: string }> {
  const { server, token } = auth(ctx);
  const variant = variantFor(args.format ?? 'video', args.language);
  const result = await downloadResult({
    server,
    token,
    videoId: args.videoId,
    variant,
    dest: args.dest,
  });
  return { path: result.path, bytes: result.bytes, variant };
}

export async function toolGetDownloadUrls(
  ctx: ToolContext,
  args: { videoId: string; format?: DownloadFormat; language?: string },
): Promise<{ variant: string; url: string }> {
  const { server, token } = auth(ctx);
  const variant = variantFor(args.format ?? 'video', args.language);
  const { url } = await apiRequest<{ url: string }>(
    server,
    `/videos/${encodeURIComponent(args.videoId)}/files`,
    { query: { variant }, token },
  );
  return { variant, url };
}

// -------------------------------------------------------- misc lifecycle

export async function toolCancel(
  ctx: ToolContext,
  args: { videoId: string },
): Promise<{ success: boolean }> {
  const { server, token } = auth(ctx);
  return apiRequest(server, `/videos/${encodeURIComponent(args.videoId)}/cancel`, {
    method: 'POST',
    token,
  });
}

export async function toolDelete(
  ctx: ToolContext,
  args: { videoId: string },
): Promise<{ success: boolean }> {
  const { server, token } = auth(ctx);
  return apiRequest(server, `/videos/${encodeURIComponent(args.videoId)}`, {
    method: 'DELETE',
    token,
  });
}

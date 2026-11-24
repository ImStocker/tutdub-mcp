/** Typed HTTP client for the TutDub server API. */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  token?: string | null;
  query?: Record<string, string | number | undefined>;
}

export async function apiRequest<T>(
  server: string,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const url = new URL(`${server.replace(/\/+$/, '')}${path}`);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    throw new ApiError(
      `Cannot reach ${url.origin}: ${err instanceof Error ? err.message : String(err)}`,
      0,
      'NETWORK',
    );
  }

  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let code: string | undefined;
    try {
      const data = (await res.json()) as { error?: string; code?: string };
      if (data.error) message = data.error;
      code = data.code;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status, code);
  }
  return (await res.json()) as T;
}

// ------------------------------------------------------------------ types

export type JobStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface PublicJob {
  language: string;
  status: JobStatus;
  /** 0..100 */
  progress: number;
  stage: string | null;
  error: string | null;
  /** True when the worker produced an .srt for this language. */
  subtitles?: boolean;
  /**
   * Subtitle-only job (no dubbed media). `language` is the pseudo-code
   * `source` for source-language subtitles.
   */
  subtitlesOnly?: boolean;
}

export interface Video {
  id: string;
  title: string;
  fileName: string;
  fileSize: number;
  duration: number;
  sourceLang: string;
  languages: string[];
  targetLangs: string[];
  status: 'processing' | 'completed' | 'failed';
  progress: number;
  jobs: PublicJob[];
  reason: string | null;
  contentType: string | null;
  cost: number;
  creditCost: number;
  filesAvailable: boolean;
  filesExpireAt: number | null;
  /**
   * Poster image the client captured at upload time, echoed back as a
   * `data:image/...` URL. Tools strip it from responses: it can be up to
   * 512 KB of base64 text that nothing can render on the wire.
   */
  thumbnail?: string | null;
  createdAt?: number;
  completedAt?: number | null;
}

export interface UploadPart {
  partNumber: number;
  url: string;
}

export interface UploadSession {
  key: string;
  uploadId: string;
  partSize: number;
  partCount: number;
  expiresAt: string;
  parts: UploadPart[];
}

export interface UploadOptions {
  clean?: boolean;
  clone?: boolean;
  removeNoise?: boolean;
  adaptVideo?: boolean;
  /**
   * Worker flag with INVERTED UI semantics: the frontend's "Adapt audio
   * timeline" checkbox (default checked) sends `false`. We mirror the UI:
   * `adaptAudioTimeline: true` -> `adaptTimingAudio: false`.
   */
  adaptTimingAudio?: boolean;
  emailNotify?: boolean;
  scenario?: string;
  /**
   * Subtitle-only jobs: the worker stops after transcription/refinement and
   * produces .srt files only (no dubbed media). With `languages: []` the
   * subtitles come out in the (possibly auto-detected) source language as
   * the `source-srt` file variant.
   */
  subtitlesOnly?: boolean;
}

export interface CliSession {
  id: string;
  status: 'pending' | 'approved' | 'exchanged' | 'expired';
  name: string;
  expiresAt: string;
}

export interface CliApproval {
  code: string;
  redirectUri: string;
  state: string | null;
}

export interface TokenResponse {
  token: string;
  name: string;
}

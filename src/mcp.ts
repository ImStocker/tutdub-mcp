/**
 * TutDub MCP server (stdio transport).
 *
 * Exposes the dubbing workflow as tools:
 *   upload_media     -> uploads a video or audio file, returns videoId
 *   start_dub        -> translate/dub: adds target languages to an existing upload
 *   transcribe_media -> subtitles only (transcribe or translate the text)
 *   get_status       -> per-language job progress / errors / subtitles flag
 *   list_media
 *   get_download_urls / download_result (video | audio | srt | original)
 *   cancel_media / delete_media
 *   whoami           -> auth diagnostics
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { whoami } from './auth';
import { getSettings } from './config';
import { version } from '../package.json';
import {
  createContext,
  toolCancel,
  toolDelete,
  toolDownload,
  toolGetDownloadUrls,
  toolGetStatus,
  toolListVideos,
  toolStartDub,
  toolTranscribe,
  toolUpload,
} from './tools';

const LANG = z
  .string()
  .min(2)
  .max(16)
  .describe('Language code, e.g. "en", "de", "pt-BR"');

const OPTIONS = z
  .object({
    clean: z.boolean().optional().describe('Remove filler words (default true)'),
    clone: z.boolean().optional().describe('Clone the speaker voice (default true)'),
    removeNoise: z.boolean().optional().describe('Remove background noise'),
    adaptVideo: z.boolean().optional().describe('Adapt video timeline (Pro/Business)'),
    adaptAudioTimeline: z
      .boolean()
      .optional()
      .describe('Adapt audio timeline to the dub (default checked, i.e. on)'),
    emailNotify: z.boolean().optional().describe('Email when processing finishes'),
    scenario: z
      .string()
      .max(10000)
      .optional()
      .describe('Plain-text scenario guiding the translation (Pro/Business)'),
  })
  .optional();

/** Options that still matter for subtitle-only runs (no media is rendered). */
const SUBS_OPTIONS = z
  .object({
    clean: z
      .boolean()
      .optional()
      .describe('Remove filler words from the transcript (default true)'),
    emailNotify: z.boolean().optional().describe('Email when processing finishes'),
    scenario: z
      .string()
      .max(10000)
      .optional()
      .describe('Plain-text scenario guiding the refinement/translation (Pro/Business)'),
  })
  .optional();

/** Wraps a tool callback: JSON-pretty output, errors as readable text. */
function tool<A>(
  fn: (args: A) => Promise<unknown>,
): (args: A) => Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  return async (args: A) => {
    try {
      const result = await fn(args);
      return {
        content: [
          { type: 'text', text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      } as { content: Array<{ type: 'text'; text: string }> };
    }
  };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'tutdub', version });
  // Progress/logs must never touch stdout (it carries the MCP protocol).
  const log = (line: string) => console.error(`[tutdub] ${line}`);
  const ctx = () => createContext({});

  server.registerTool(
    'whoami',
    {
      title: 'Check login status',
      description:
        'Returns the TutDub account the CLI is logged in as. Use this to ' +
        'verify credentials before other operations.',
      inputSchema: {},
    },
    tool(async () => {
      const settings = getSettings();
      if (!settings.token) {
        return {
          loggedIn: false,
          hint: 'Run `tutdub-mcp login` in a terminal to sign in via the browser.',
        };
      }
      const user = await whoami(settings);
      return { loggedIn: true, user, server: settings.server };
    }),
  );

  const uploadMediaConfig = {
    title: 'Upload a video or audio file for dubbing',
    description:
      'Uploads a local media file — video (mp4, mov, webm, …) or audio ' +
      '(mp3, wav, m4a, …; audio is processed as audio) — to TutDub and ' +
      'starts dubbing into the given target languages. Returns the video ' +
      'id used by the other tools. Requires credits; duration is probed ' +
      'from the file (pass duration explicitly if probing fails).',
    inputSchema: {
      path: z.string().describe('Absolute or relative path to the media file'),
      languages: z.array(LANG).min(1).max(5).describe('Target language codes'),
      sourceLang: z
        .string()
        .optional()
        .describe('Source language code, or omit/auto for detection'),
      title: z.string().max(255).optional().describe('Display title'),
      duration: z
        .number()
        .min(1)
        .optional()
        .describe('Duration in seconds (overrides probing)'),
      options: OPTIONS,
    },
  };
  server.registerTool('upload_media', uploadMediaConfig, tool((args) => {
    log(`upload ${args.path} -> [${args.languages.join(', ')}]`);
    return toolUpload(ctx(), args);
  }));

  server.registerTool(
    'start_dub',
    {
      title: 'Translate (dub) an uploaded video or audio file into more languages',
      description:
        'Adds target languages to an already-uploaded video or audio file ' +
        '(additive: existing results are kept). "translate" and "dub" mean ' +
        'the same thing here: the output is dubbed media. For text-only ' +
        'translation (subtitles without dubbing) use transcribe_media with ' +
        'a target language. Returns the updated video with per-language ' +
        'job status.',
      inputSchema: {
        videoId: z.string().describe('Video id from upload_media / list_media'),
        languages: z.array(LANG).min(1).max(5).describe('New target language codes'),
      },
    },
    tool((args) => {
      log(`dub ${args.videoId} -> [${args.languages.join(', ')}]`);
      return toolStartDub(ctx(), args);
    }),
  );

  const transcribeMediaConfig = {
    title: 'Generate subtitles only (transcribe or translate text)',
    description:
      'Produces subtitles for a local video/audio file (uploads it) or an ' +
      'existing videoId — WITHOUT dubbed output: the worker stops right ' +
      'after transcription and refinement. language: "source" (default) = ' +
      'transcription in the source language (auto-detected when omitted ' +
      'at upload); any other code = translated subtitles for that ' +
      'language. Poll get_status until the job succeeds, then download ' +
      'with download_result (format "srt", language "source" or the ' +
      'target code). Costs the same as dubbing per language.',
    inputSchema: {
      path: z
        .string()
        .optional()
        .describe('Local video/audio file to upload (omit when videoId is given)'),
      videoId: z
        .string()
        .optional()
        .describe('Existing video id to request subtitles for (omit when path is given)'),
      language: z
        .string()
        .optional()
        .describe('"source" (default) for transcription, or a target language code for a translation'),
      sourceLang: z
        .string()
        .optional()
        .describe('Source language code or auto (upload path only)'),
      title: z.string().max(255).optional().describe('Display title (upload path only)'),
      duration: z
        .number()
        .min(1)
        .optional()
        .describe('Duration in seconds, overrides probing (upload path only)'),
      options: SUBS_OPTIONS,
    },
  };
  server.registerTool('transcribe_media', transcribeMediaConfig, tool(async (args) => {
    const target = args.path ?? args.videoId ?? '?';
    log(`transcribe ${target} (${args.language ?? 'source'})`);
    const result = await toolTranscribe(ctx(), args);
    return {
      ...result,
      hint:
        `Poll get_status for videoId ${result.videoId} until the "source" ` +
        `job (or "${result.language}") succeeds, then call download_result ` +
        `{ videoId, format: "srt", language: "${result.language}" }.`,
    };
  }));

  server.registerTool(
    'get_status',
    {
      title: 'Get dubbing status',
      description:
        'Returns processing status for an upload (video or audio): overall ' +
        'state, progress and per-language jobs (queued/running/succeeded/' +
        'failed with errors), plus whether .srt subtitles are available and ' +
        'when files expire.',
      inputSchema: {
        videoId: z.string().describe('Video/audio id'),
      },
    },
    tool((args) => toolGetStatus(ctx(), args)),
  );

  server.registerTool(
    'list_media',
    {
      title: 'List my uploads',
      description:
        'Returns all video/audio uploads of the logged-in account, newest first.',
      inputSchema: {},
    },
    tool(() => toolListVideos(ctx())),
  );

  server.registerTool(
    'get_download_urls',
    {
      title: 'Get download URLs',
      description:
        'Returns a short-lived presigned URL for a result file. format: ' +
        '"video" (dubbed video, default), "audio" (audio track), "srt" ' +
        '(subtitles) or "original" (source file). For subtitles pass ' +
        'language: "source" (transcription, variant source-srt) or a target ' +
        'code (translated subtitles). URL expires quickly - download ' +
        'immediately or use download_result.',
      inputSchema: {
        videoId: z.string().describe('Video id'),
        format: z
          .enum(['video', 'audio', 'srt', 'original'])
          .optional()
          .describe('Result kind (default video)'),
        language: LANG.optional().describe(
          'Language code for srt (use "source" for the transcription); not needed for original/video of a language',
        ),
      },
    },
    tool((args) => toolGetDownloadUrls(ctx(), args)),
  );

  server.registerTool(
    'download_result',
    {
      title: 'Download a result file',
      description:
        'Downloads a result file to this machine (video, audio, srt or the ' +
        'original source). Subtitles: language "source" = transcription ' +
        '(source-srt), any other code = translated subtitles. Returns the ' +
        'local path and byte size.',
      inputSchema: {
        videoId: z.string().describe('Video id'),
        format: z
          .enum(['video', 'audio', 'srt', 'original'])
          .optional()
          .describe('Result kind (default video)'),
        language: LANG.optional().describe(
          'Language code for srt (use "source" for the transcription); not needed for original',
        ),
        dest: z
          .string()
          .optional()
          .describe('Target file or directory (default: current directory)'),
      },
    },
    tool((args) => {
      log(`download ${args.videoId} [${args.format ?? 'video'}${args.language ? `:${args.language}` : ''}]`);
      return toolDownload(ctx(), args);
    }),
  );

  server.registerTool(
    'cancel_media',
    {
      title: 'Cancel processing',
      description:
        'Cancels all in-flight jobs of a video/audio upload and refunds ' +
        'unfinished work. Finished languages stay downloadable.',
      inputSchema: {
        videoId: z.string().describe('Video/audio id'),
      },
    },
    tool((args) => toolCancel(ctx(), args)),
  );

  server.registerTool(
    'delete_media',
    {
      title: 'Delete an upload',
      description:
        'Deletes a video/audio upload and its result files from TutDub. ' +
        'Unfinished jobs are cancelled and refunded. This cannot be undone.',
      inputSchema: {
        videoId: z.string().describe('Video/audio id'),
      },
    },
    tool((args) => toolDelete(ctx(), args)),
  );

  return server;
}

/** Runs the MCP server on stdio (does not return until the client exits). */
export async function serveMcp(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[tutdub] MCP server ready on stdio');
}

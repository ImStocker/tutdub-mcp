/**
 * Best-effort poster/thumbnail capture for uploads - without ffmpeg.
 *
 * The server accepts a `data:image/...` data URL (<= 512 KB) in the upload
 * start payload and shows it as the poster, exactly like the web app does
 * with its <video>+canvas capture. A desktop machine usually has a cheaper
 * source than decoding video:
 *
 *   1. the OS thumbnail the file manager itself would draw -
 *      Windows Explorer's shell thumbnail (IShellItemImageFactory, which
 *      generates on demand via Media Foundation), macOS QuickLook
 *      (qlmanage), or `ffmpegthumbnailer` on Linux when installed;
 *   2. embedded cover art parsed straight out of the mp4 container.
 *
 * Everything here is best-effort: any failure or timeout returns null and
 * the upload simply proceeds without a poster. Audio files are never
 * captured (the web app does not thumbnail audio either).
 *
 * The platform helpers ship as embedded script strings - not loose files -
 * so they survive `bun build --compile`.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { basename, delimiter, extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { contentTypeFor, isAudioContentType, probeCoverArt } from './media';

/** Server limit: UploadStartDto.thumbnail MaxLength (512 * 1024). */
export const MAX_THUMBNAIL_BYTES = 512 * 1024;

const THUMB_SIZE = 640;
const DEFAULT_TIMEOUT_MS = 6000;
/** Windows first run compiles the C# helper with csc (Defender can slow it). */
const WIN_TIMEOUT_MS = 8000;

export type ThumbnailSource =
  | 'shell'
  | 'quicklook'
  | 'ffmpegthumbnailer'
  | 'cover-art';

export interface CapturedThumbnail {
  /** `data:image/...;base64,...` URL ready for UploadStartDto.thumbnail. */
  dataUrl: string;
  source: ThumbnailSource;
  bytes: number;
}

/** Raw image produced by an OS source. */
export interface RawThumbnailCapture {
  bytes: Buffer;
  mime: string;
  source: Exclude<ThumbnailSource, 'cover-art'>;
}

export interface CaptureOptions {
  timeoutMs?: number;
  /**
   * Test seam: replaces the OS capture step. `null` skips the OS step
   * entirely (only embedded cover art is tried).
   */
  osCapture?:
    | ((filePath: string, timeoutMs: number) => Promise<RawThumbnailCapture | null>)
    | null;
}

function toDataUrl(bytes: Buffer, mime: string): string {
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function finalize(raw: {
  bytes: Buffer;
  mime: string;
  source: ThumbnailSource;
}): CapturedThumbnail | null {
  const dataUrl = toDataUrl(raw.bytes, raw.mime);
  // The server rejects anything longer; dropping the poster beats a 400.
  if (dataUrl.length > MAX_THUMBNAIL_BYTES) return null;
  return { dataUrl, source: raw.source, bytes: raw.bytes.length };
}

/**
 * Captures a poster for a media file, or null when none is available.
 * Never throws: the caller uploads with or without it.
 */
export async function captureThumbnail(
  filePath: string,
  opts: CaptureOptions = {},
): Promise<CapturedThumbnail | null> {
  try {
    if (isAudioContentType(contentTypeFor(basename(filePath)))) return null;
    const timeoutMs =
      opts.timeoutMs ??
      (process.platform === 'win32' ? WIN_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);

    let raw: RawThumbnailCapture | null = null;
    try {
      if (opts.osCapture === null) raw = null;
      else if (opts.osCapture) raw = await opts.osCapture(filePath, timeoutMs);
      else raw = await osCapture(filePath, timeoutMs);
    } catch {
      raw = null;
    }
    if (raw) {
      const hit = finalize(raw);
      if (hit) return hit;
    }

    // Free fallback: artwork already embedded in the container.
    const cover = probeCoverArt(filePath);
    if (cover) {
      return finalize({ bytes: cover.bytes, mime: cover.mime, source: 'cover-art' });
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Converts a user-supplied image into a data URL the server accepts.
 * Unlike captureThumbnail this throws: the caller passed the file on
 * purpose, so a broken path or oversized image deserves a clear error.
 */
export function imageFileToDataUrl(filePath: string): string {
  const mime = IMAGE_MIME_BY_EXT[extname(filePath).toLowerCase()];
  if (!mime) {
    throw new Error(
      `Unsupported thumbnail image "${filePath}" ` +
        `(use .jpg, .jpeg, .png, .webp, .gif, .bmp or .avif)`,
    );
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (err) {
    throw new Error(
      `Cannot read thumbnail image ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (bytes.length === 0) {
    throw new Error(`Thumbnail image is empty: ${filePath}`);
  }
  const dataUrl = toDataUrl(bytes, mime);
  if (dataUrl.length > MAX_THUMBNAIL_BYTES) {
    throw new Error(
      `Thumbnail image is too large (${bytes.length} bytes; the server accepts ` +
        `at most ${MAX_THUMBNAIL_BYTES} bytes as a data URL). Resize it first, ` +
        'or drop the explicit thumbnail to auto-capture one instead.',
    );
  }
  return dataUrl;
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

// ------------------------------------------------------------- OS sources

async function osCapture(
  filePath: string,
  timeoutMs: number,
): Promise<RawThumbnailCapture | null> {
  switch (process.platform) {
    case 'win32':
      return windowsShellThumbnail(filePath, timeoutMs);
    case 'darwin':
      return quickLookThumbnail(filePath, timeoutMs);
    case 'linux':
      return ffmpegthumbnailerThumbnail(filePath, timeoutMs);
    default:
      return null;
  }
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a helper process with a hard timeout; spawn failures -> code -1. */
async function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; env?: Record<string, string> },
): Promise<RunResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([cmd, ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...opts.env },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    return { code: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
  let stdout = '';
  let stderr = '';
  try {
    [stdout, stderr] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    ]);
  } catch {
    /* killed by the timeout signal */
  }
  let code = -1;
  try {
    code = await proc.exited;
  } catch {
    code = -1;
  }
  return { code, stdout, stderr };
}

// ---------------------------------------------------------------- Windows

/**
 * Windows: ask the shell for the exact thumbnail Explorer would draw.
 * `powershell.exe` (present on every desktop Windows) runs an embedded C#
 * helper: SHCreateItemFromParsingName -> IShellItemImageFactory::GetImage
 * (THUMBNAILONLY|RESIZETOFIT, 640px) -> JPEG bytes as base64 on stdout.
 * GetImage generates the thumbnail on demand when it is not cached yet.
 * IIDs/signature verified against ShObjIdl_core.idl (Windows 10/11 SDK).
 *
 * The script is passed with -EncodedCommand (UTF-16LE base64) and the file
 * path via environment variable, so no quoting is involved anywhere.
 */
async function windowsShellThumbnail(
  filePath: string,
  timeoutMs: number,
): Promise<RawThumbnailCapture | null> {
  const script = Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64');
  // SHCreateItemFromParsingName rejects forward slashes (E_INVALIDARG), and
  // a relative path would resolve against powershell.exe's cwd. path.resolve
  // gives an absolute, backslash-normalized Windows path. May throw (e.g.
  // invalid characters) - thumbnail capture is best-effort.
  let absPath: string;
  try {
    absPath = resolve(filePath);
  } catch {
    return null;
  }
  const res = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-STA',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      script,
    ],
    {
      timeoutMs,
      env: {
        TUTDUB_THUMB_FILE: absPath,
        TUTDUB_THUMB_MAXBYTES: String(maxRawBytes()),
      },
    },
  );
  if (res.code !== 0) return null;
  const b64 = res.stdout.trim();
  if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return null;
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  return { bytes, mime: 'image/jpeg', source: 'shell' };
}

/** Largest JPEG payload whose data URL still fits the server limit. */
function maxRawBytes(): number {
  return Math.floor(((MAX_THUMBNAIL_BYTES - 64) * 3) / 4);
}

// ----------------------------------------------------------------- macOS

/**
 * macOS: QuickLook (`qlmanage`) renders the thumbnail with the system
 * codecs; `sips` (both ship with macOS) converts it to a bounded JPEG.
 */
async function quickLookThumbnail(
  filePath: string,
  timeoutMs: number,
): Promise<RawThumbnailCapture | null> {
  const dir = mkdtempSync(join(tmpdir(), 'tutdub-thumb-'));
  try {
    const gen = await run(
      'qlmanage',
      ['-t', '-s', String(THUMB_SIZE), '-o', dir, filePath],
      { timeoutMs },
    );
    // qlmanage writes a generic icon when generation fails, so trust the
    // process output before using whatever .png appeared.
    if (/fail|error/i.test(gen.stderr)) return null;
    const pngName = readdirSync(dir).find((f) => f.toLowerCase().endsWith('.png'));
    if (!pngName) return null;
    const pngPath = join(dir, pngName);
    const png = readFileSync(pngPath);
    if (!png.length) return null;

    const outPath = join(dir, 'thumb.jpg');
    const conv = await run(
      'sips',
      [
        '-s', 'format', 'jpeg',
        '-s', 'formatOptions', '72',
        '-Z', String(THUMB_SIZE),
        pngPath, '--out', outPath,
      ],
      { timeoutMs: Math.max(2000, Math.floor(timeoutMs / 2)) },
    );
    if (conv.code === 0 && existsSync(outPath)) {
      const jpg = readFileSync(outPath);
      if (jpg.length) return { bytes: jpg, mime: 'image/jpeg', source: 'quicklook' };
    }
    // sips unavailable/failed: pass the PNG through if it fits the budget
    // (finalize() enforces the limit).
    return { bytes: png, mime: 'image/png', source: 'quicklook' };
  } catch {
    return null;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

// ----------------------------------------------------------------- Linux

/**
 * Linux: there is no standard OS thumbnail API (each desktop has its own
 * thumbnailer), so use `ffmpegthumbnailer` - a tiny standalone tool that
 * file managers commonly install - when it is on PATH, else give up.
 */
async function ffmpegthumbnailerThumbnail(
  filePath: string,
  timeoutMs: number,
): Promise<RawThumbnailCapture | null> {
  const exe = findOnPath('ffmpegthumbnailer');
  if (!exe) return null;
  const dir = mkdtempSync(join(tmpdir(), 'tutdub-thumb-'));
  try {
    const outPath = join(dir, 'thumb.jpg');
    const res = await run(
      exe,
      ['-i', filePath, '-o', outPath, '-s', String(THUMB_SIZE), '-q', '7'],
      { timeoutMs },
    );
    if (res.code !== 0 || !existsSync(outPath)) return null;
    const jpg = readFileSync(outPath);
    if (!jpg.length) return null;
    return { bytes: jpg, mime: 'image/jpeg', source: 'ffmpegthumbnailer' };
  } catch {
    return null;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

function findOnPath(name: string): string | null {
  const raw = process.env.PATH;
  if (!raw) return null;
  for (const dir of raw.split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

// The helper script must not contain backticks or `${` (it lives inside a
// TS template literal). No backticks are used in PowerShell here anyway.
const POWERSHELL_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$cs = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class TutDubThumb
{
    [StructLayout(LayoutKind.Sequential)]
    private struct SIZE { public int cx; public int cy; }

    [Flags]
    private enum SIIGBF
    {
        RESIZETOFIT = 0x0,
        BIGGERSIZEOK = 0x1,
        THUMBNAILONLY = 0x8
    }

    [ComImport]
    [Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItemImageFactory
    {
        [PreserveSig]
        int GetImage(SIZE size, SIIGBF flags, out IntPtr phbm);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(
        string pszPath, IntPtr pbc, ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out object ppv);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr hObject);

    private static byte[] EncodeJpeg(Bitmap bmp, long quality)
    {
        ImageCodecInfo codec = null;
        foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders())
        {
            if (c.FormatID == ImageFormat.Jpeg.Guid) { codec = c; break; }
        }
        if (codec == null) throw new InvalidOperationException("No JPEG encoder");
        using (MemoryStream ms = new MemoryStream())
        using (EncoderParameters ep = new EncoderParameters(1))
        {
            ep.Param[0] = new EncoderParameter(Encoder.Quality, quality);
            bmp.Save(ms, codec, ep);
            return ms.ToArray();
        }
    }

    public static byte[] Generate(string path, int maxW, int maxH, long maxBytes)
    {
        Guid iid = typeof(IShellItemImageFactory).GUID;
        object item;
        SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item);
        IShellItemImageFactory factory = (IShellItemImageFactory)item;
        IntPtr hbm = IntPtr.Zero;
        try
        {
            SIZE size = new SIZE();
            size.cx = maxW;
            size.cy = maxH;
            int hr = factory.GetImage(size, SIIGBF.THUMBNAILONLY | SIIGBF.RESIZETOFIT, out hbm);
            if (hr != 0 || hbm == IntPtr.Zero)
            {
                hbm = IntPtr.Zero;
                hr = factory.GetImage(size, SIIGBF.THUMBNAILONLY | SIIGBF.RESIZETOFIT | SIIGBF.BIGGERSIZEOK, out hbm);
            }
            if (hbm == IntPtr.Zero)
            {
                throw new Exception("no thumbnail (hr=0x" + hr.ToString("X8") + ")");
            }
            using (Bitmap src = Bitmap.FromHbitmap(hbm))
            {
                int w = src.Width;
                int h = src.Height;
                if (w < 1 || h < 1) throw new Exception("empty thumbnail");
                int ow = w;
                int oh = h;
                if (w > maxW || h > maxH)
                {
                    double scale = Math.Min((double)maxW / w, (double)maxH / h);
                    ow = Math.Max(1, (int)Math.Round(w * scale));
                    oh = Math.Max(1, (int)Math.Round(h * scale));
                }
                using (Bitmap outBmp = new Bitmap(ow, oh, PixelFormat.Format24bppRgb))
                {
                    using (Graphics g = Graphics.FromImage(outBmp))
                    {
                        g.Clear(Color.White);
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                        g.DrawImage(src, 0, 0, ow, oh);
                    }
                    long[] qualities = new long[] { 72L, 55L, 40L, 25L };
                    foreach (long q in qualities)
                    {
                        byte[] jpeg = EncodeJpeg(outBmp, q);
                        if (jpeg.LongLength <= maxBytes || q == qualities[qualities.Length - 1])
                        {
                            return jpeg;
                        }
                    }
                }
            }
        }
        finally
        {
            if (hbm != IntPtr.Zero) DeleteObject(hbm);
            Marshal.ReleaseComObject(item);
        }
        throw new Exception("unreachable");
    }
}
'@

try {
    $path = $env:TUTDUB_THUMB_FILE
    $maxBytes = [int64]0
    [void][int64]::TryParse($env:TUTDUB_THUMB_MAXBYTES, [ref]$maxBytes)
    if ($maxBytes -le 0) { $maxBytes = 393168 }
    $loaded = $false
    try {
        # Compile the helper once and cache the assembly (Add-Type recompiles
        # from scratch on every run otherwise).
        $sha = [System.Security.Cryptography.SHA1]::Create()
        $hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($cs))) -replace '-', '').ToLower()
        $dll = Join-Path ([IO.Path]::GetTempPath()) ('tutdub-thumb-' + $hash + '.dll')
        if (-not (Test-Path -LiteralPath $dll)) {
            Add-Type -TypeDefinition $cs -ReferencedAssemblies @('System.Drawing', 'System') -OutputAssembly $dll -ErrorAction Stop
        }
        Add-Type -Path $dll -ErrorAction Stop
        $loaded = $true
    } catch {
        $loaded = $false
    }
    if (-not $loaded) {
        try {
            Add-Type -TypeDefinition $cs -ReferencedAssemblies @('System.Drawing', 'System') -ErrorAction Stop
        } catch {
            # A cached assembly may already be loaded - the type then resolves.
            if (-not ('TutDubThumb' -as [type])) { throw }
        }
    }
    $bytes = [TutDubThumb]::Generate($path, 640, 640, $maxBytes)
    [Console]::Write([Convert]::ToBase64String($bytes))
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}`;

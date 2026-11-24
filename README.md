# TutDub MCP Server and CLI

A small command-line utility and **MCP server** for [TutDub](https://tutdub.com) —
upload a video, dub it into other languages, and download the results —
keeping the original voice.

- **CLI** for scripting and quick use in a terminal
- **MCP server** (stdio) so AI assistants can drive the same workflow

Licensed under [MIT](./LICENSE).

## Requirements

### For installing via Bun

Applies to Installation Option 1 (`bunx` / `bun add -g`):

- [Bun](https://bun.sh) ≥ 1.1 — install it with
  `irm bun.sh/install.ps1 | iex` (Windows) or
  `curl -fsSL https://bun.sh/install | bash` (macOS/Linux).

### For the standalone binary

Nothing — Option 2's binaries are self-contained.

## Install

### Option 1 — one command with Bun

```sh
bunx tutdub-mcp
```

…or install it globally so the `tutdub-mcp` command is always available:

```sh
bun add -g tutdub-mcp
```

### Option 2 — standalone binary (no Bun required)

Download the binary for your platform from
[GitHub Releases](https://github.com/ImStocker/tutdub-mcp/releases/latest)
and put it on your `PATH`:

| Platform | Asset |
| --- | --- |
| Windows x64 | `tutdub-mcp-vX.Y.Z-windows-x64.exe` |
| Linux x64 | `tutdub-mcp-vX.Y.Z-linux-x64` |
| macOS (Apple Silicon) | `tutdub-mcp-vX.Y.Z-macos-arm64` |
| macOS (Intel) | `tutdub-mcp-vX.Y.Z-macos-x64` |

The binaries are self-contained: nothing else has to be installed.

```sh
# Linux / macOS: make it executable and move it to a PATH directory
chmod +x tutdub-mcp-vX.Y.Z-linux-x64
sudo mv tutdub-mcp-vX.Y.Z-linux-x64 /usr/local/bin/tutdub-mcp
```

> **macOS note:** the binaries are unsigned. If Gatekeeper blocks
> the first run ("cannot be opened because the developer cannot be
> verified"), clear the quarantine flag:
>
> ```sh
> xattr -d com.apple.quarantine /usr/local/bin/tutdub-mcp
> ```

## Sign in

```sh
tutdub-mcp login
```

This opens the TutDub login page in your browser. Click **Authorize**,
then close the tab and return to the terminal — the CLI picks up the
result automatically. The token is stored in a local config file
(`~/.config/tutdub-mcp/config.json`,
`%APPDATA%\tutdub-mcp\config.json` on Windows,
`~/Library/Application Support/tutdub-mcp/config.json` on macOS).

Options:

| Flag | Description |
| --- | --- |
| `--server URL` | API base (default `https://tutdub.com/api/v1`) |
| `--frontend URL` | Frontend base (default `https://tutdub.com/app`) |
| `--name DEVICE` | Device label shown on the authorize page (default: hostname) |
| `--no-browser` | Print the URL instead of opening a browser |

Sign out:

```sh
tutdub-mcp logout
```

## CLI usage

```sh
# Upload a file (video or audio) and start dubbing; prints the media id
tutdub-mcp upload ./lesson.mp4 --lang es,fr --watch

# Poster image on video uploads (automatic by default)
tutdub-mcp upload ./lesson.mp4 --lang es --no-thumbnail   # gather nothing
tutdub-mcp upload ./lesson.mp4 --lang es --thumbnail ./poster.jpg  # own image

# Add more languages later ("translate" is a synonym of "dub")
tutdub-mcp dub <mediaid> --lang de
tutdub-mcp translate <mediaid> --lang de

# Subtitles only - no dubbed media: transcribe, or translate the text
tutdub-mcp transcribe ./lesson.mp4 --watch          # source-language .srt
tutdub-mcp transcribe ./lesson.mp4 --lang es        # translated .srt
tutdub-mcp transcribe <mediaid>                     # subtitles for an existing video

# Check progress (per-language jobs, errors, subtitles flag)
tutdub-mcp status <mediaid>
tutdub-mcp status <mediaid> --watch     # poll until finished

# List your videos
tutdub-mcp list

# Download results: dubbed video, audio track, subtitles, or source
tutdub-mcp download <mediaid> --lang es --format video
tutdub-mcp download <mediaid> --lang es --format audio
tutdub-mcp download <mediaid> --lang es --format srt     # translated subs
tutdub-mcp download <mediaid> --lang source --format srt # transcription
tutdub-mcp download <mediaid> --format original

# Account
tutdub-mcp whoami
tutdub-mcp logout
```

Common flags: `--json` (machine-readable output), `--server` / `--frontend`
(per-command overrides), `--title`, `--source-lang`, `--duration`
(override duration probing), `--dest`, `--thumbnail IMG` /
`--no-thumbnail` (poster capture for `upload`/`transcribe`, see
[Poster thumbnails](#poster-thumbnails)).

> **Note on audio-only dubbing:** pass an audio file (`.mp3`, `.wav`, …)
> and it is processed as audio. Media id for audio called `videoId` on TutDub server

## MCP server

Run `tutdub-mcp` with no arguments (or `tutdub-mcp serve`) to start the
MCP server on stdio. Example client configuration:

```json
{
  "mcpServers": {
    "tutdub": {
      "command": "bunx",
      "args": ["tutdub-mcp"]
    }
  }
}
```

If you installed it globally, `"command": "tutdub-mcp"` with no args works
too.

### Tools

| Tool | Purpose |
| --- | --- |
| `whoami` | Check login status / account |
| `upload_media` | Upload a local **video or audio** file → starts dubbing, returns `videoId` (same name for video and audio) |
| `start_dub` | **Translate/dub** an uploaded video or audio file into more languages (the "translate" entry point; text-only translation = `transcribe_media`) |
| `transcribe_media` | **Subtitles only, no media**: upload a video/audio file or use an existing `videoId`; `language: "source"` (default) = transcription, any other code = translated text |
| `get_status` | Per-language job progress, errors, `.srt` availability, file expiry |
| `list_media` | List account uploads (video and audio) |
| `get_download_urls` | Short-lived download URL for `video` / `audio` / `srt` / `original` |
| `download_result` | Download a result file to this machine (returns path + size); subtitles via `format: "srt"` + `language: "source"` or a target code |
| `cancel_media` | Cancel processing (refunds unfinished work) |
| `delete_media` | Delete an upload and its files |

Upload options mirror the web app: `clean`, `clone`, `removeNoise`,
`adaptVideo`, `adaptAudioTimeline` (default on), `emailNotify`,
`scenario`.

Video uploads also carry a poster thumbnail, gathered automatically by
default; `upload_media` / `transcribe_media` accept `captureThumbnail:
false` to skip it or `thumbnailPath` to supply your own image (see
[Poster thumbnails](#poster-thumbnails)).

## Configuration

Precedence: **flags > environment > `.env` > config file > defaults**.

| Env var | Meaning | Default |
| --- | --- | --- |
| `TUTDUB_SERVER_URL` | API base URL | `https://tutdub.com/api/v1` |
| `TUTDUB_FRONTEND_URL` | Frontend base URL | `https://tutdub.com/app` |
| `TUTDUB_TOKEN` | Overrides the stored CLI token | — |
| `TUTDUB_THUMBNAIL` | Gather a poster thumbnail on video uploads (`true`/`false`) | `true` |
| `TUTDUB_CONFIG_HOME` | Overrides the config directory | per-OS default |
| `TUTDUB_ENV_FILE` | Explicit `.env` file to load | `.env` in the working directory |

### Poster thumbnails

Video uploads include a poster image — the same one the web app shows. It
is gathered automatically by default, is best-effort, and never blocks an
upload: if no image can be found, the upload simply proceeds without one.
Audio files never get a poster.

| Want to… | How |
| --- | --- |
| Skip it for one command | `--no-thumbnail` on `upload` / `transcribe` |
| Never gather it | `TUTDUB_THUMBNAIL=false` (env or `.env`), or `"thumbnail": false` in `config.json` |
| Use your own image | `--thumbnail ./poster.jpg` (jpg/png/…, ≤512 KB) |
| Skip it from MCP | `captureThumbnail: false` on `upload_media` / `transcribe_media` |
| Supply an image from MCP | `thumbnailPath: "/path/poster.jpg"` |

### `.env` file

All `TUTDUB_*` settings can be placed in a `.env` file instead of the
environment — copy [`.env.example`](./.env.example):

Rules:

- `.env` is read from the directory you run the command in; set
  `TUTDUB_ENV_FILE=/path/to/.env` to load a specific file instead (useful
  for MCP hosts that launch the server with an unrelated working
  directory).
- Variables already present in the environment are **never** overridden by
  the file (standard dotenv behavior); flags win over both.
- Note: `tutdub-mcp login` stores the effective URLs in the config file, so
  they keep applying after you delete the `.env` until you change them
  there (the token always belongs to the server it was issued by).

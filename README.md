# tutdub-mcp

A small command-line utility and **MCP server** for [TutDub](https://tutdub.com) —
upload a video, dub it into other languages, and download the results —
keeping the original voice.

- **CLI** for scripting and quick use in a terminal
- **MCP server** (stdio) so AI assistants can drive the same workflow
- **Browser sign-in / sign-out** using the login form in `tutdub-frontend`
  (no passwords ever touch the terminal; the CLI receives a *revocable*
  token that you can delete from the Account page)

Licensed under [MIT](./LICENSE).

## Requirements

- [Bun](https://bun.sh) ≥ 1.1 — only for the `bunx` / `bun add -g` install
  method (`irm bun.sh/install.ps1 | iex` on Windows,
  `curl -fsSL https://bun.sh/install | bash` on macOS/Linux). Not needed
  for the standalone binaries below.

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

The binaries are self-contained: they embed the Bun runtime and all
dependencies, so nothing else has to be installed. They behave exactly like
the npm package — same commands, same `.env` support, same config file —
and are built from the same tag on every release.

```sh
# Linux / macOS: make it executable and move it to a PATH directory
chmod +x tutdub-mcp-vX.Y.Z-linux-x64
sudo mv tutdub-mcp-vX.Y.Z-linux-x64 /usr/local/bin/tutdub-mcp
```

Each release also ships `sha256sums.txt` to verify the downloads:

```sh
sha256sum -c sha256sums.txt
```

> **macOS note:** the binaries are unsigned (no Apple Developer account /
> notarization — normal for open-source CLI releases). If Gatekeeper blocks
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

This starts a temporary listener on `127.0.0.1`, opens the TutDub login
page in your browser (`https://tutdub.com/app/cli-login?session=…`), and
waits for you to click **Authorize**. The browser is then redirected to a
local confirmation page (close the tab and return to the terminal); the
CLI also watches the session status, so login completes even if that
redirect fails. The resulting token is stored in a
local config file (`~/.config/tutdub-mcp/config.json`,
`%APPDATA%\tutdub-mcp\config.json` on Windows,
`~/Library/Application Support/tutdub-mcp/config.json` on macOS).

Options:

| Flag | Description |
| --- | --- |
| `--server URL` | API base (default `https://tutdub.com/api/v1`) |
| `--frontend URL` | Frontend base (default `https://tutdub.com/app`). For a local dev server use `http://localhost:5173/app`. |
| `--name DEVICE` | Device label shown on the authorize page (default: hostname) |
| `--no-browser` | Print the URL instead of opening a browser |

Sign out (revokes the token on the server, then clears local credentials):

```sh
tutdub-mcp logout
```

## CLI usage

```sh
# Upload a file and start dubbing; prints the video id
tutdub-mcp upload ./lesson.mp4 --lang es,fr --watch

# Add more languages later ("translate" is a synonym of "dub")
tutdub-mcp dub <videoId> --lang de
tutdub-mcp translate <videoId> --lang de

# Subtitles only - no dubbed media: transcribe, or translate the text
tutdub-mcp transcribe ./lesson.mp4 --watch          # source-language .srt
tutdub-mcp transcribe ./lesson.mp4 --lang es        # translated .srt
tutdub-mcp transcribe <videoId>                     # subtitles for an existing video

# Check progress (per-language jobs, errors, subtitles flag)
tutdub-mcp status <videoId>
tutdub-mcp status <videoId> --watch     # poll until finished

# List your videos
tutdub-mcp list

# Download results: dubbed video, audio track, subtitles, or source
tutdub-mcp download <videoId> --lang es --format video
tutdub-mcp download <videoId> --lang es --format audio
tutdub-mcp download <videoId> --lang es --format srt     # translated subs
tutdub-mcp download <videoId> --lang source --format srt # transcription
tutdub-mcp download <videoId> --format original

# Account
tutdub-mcp whoami
tutdub-mcp logout
```

Common flags: `--json` (machine-readable output), `--server` / `--frontend`
(per-command overrides), `--title`, `--source-lang`, `--duration`
(override duration probing), `--dest`.

> **Note on audio-only dubbing:** pass an audio file (`.mp3`, `.wav`, …)
> and it is processed as audio. Extracting audio from a video client-side
> is not supported yet.

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
| `upload_media` | Upload a local **video or audio** file → starts dubbing, returns `videoId` |
| `start_dub` | **Translate/dub** an uploaded video or audio file into more languages (the "translate" entry point; text-only translation = `transcribe_media`) |
| `transcribe_media` | **Subtitles only, no media**: upload a video/audio file or use an existing `videoId`; `language: "source"` (default) = transcription, any other code = translated text |
| `get_status` | Per-language job progress, errors, `.srt` availability, file expiry |
| `list_media` | List account uploads (video and audio) |
| `get_download_urls` | Short-lived presigned URL for `video` / `audio` / `srt` / `original` |
| `download_result` | Download a result file to this machine (returns path + size); subtitles via `format: "srt"` + `language: "source"` or a target code |
| `cancel_media` | Cancel processing (refunds unfinished work) |
| `delete_media` | Delete an upload and its files |

Upload options mirror the web app: `clean`, `clone`, `removeNoise`,
`adaptVideo`, `adaptAudioTimeline` (default on; sent inverted to the
worker exactly like the frontend), `emailNotify`, `scenario`.

## Configuration

Precedence: **flags > environment > `.env` > config file > defaults**.

| Env var | Meaning | Default |
| --- | --- | --- |
| `TUTDUB_SERVER_URL` | API base URL | `https://tutdub.com/api/v1` |
| `TUTDUB_FRONTEND_URL` | Frontend base URL | `https://tutdub.com/app` |
| `TUTDUB_TOKEN` | Overrides the stored CLI token | — |
| `TUTDUB_CONFIG_HOME` | Overrides the config directory | per-OS default |
| `TUTDUB_ENV_FILE` | Explicit `.env` file to load | `.env` in the working directory |

### `.env` file

All `TUTDUB_*` settings can be placed in a `.env` file instead of the
environment — copy [`.env.example`](./.env.example):

```dotenv
TUTDUB_SERVER_URL=http://localhost:5453/v1
TUTDUB_FRONTEND_URL=http://localhost:5173/app
```

```sh
tutdub-mcp upload ./lesson.mp4 --lang es   # picks the .env values up
```

Rules:

- `.env` is read from the directory you run the command in; set
  `TUTDUB_ENV_FILE=/path/to/.env` to load a specific file instead (useful
  for MCP hosts that launch the server with an unrelated working
  directory).
- Variables already present in the environment are **never** overridden by
  the file (standard dotenv behavior); flags win over both.
- The file is read once at process startup.
- Note: `tutdub-mcp login` stores the effective URLs in the config file, so
  they keep applying after you delete the `.env` until you change them
  there (the token always belongs to the server it was issued by).

## Development

```sh
bun install          # install dependencies
bun test             # unit + integration tests (mock server)
bun run typecheck    # tsc --noEmit
bun run smoke        # MCP initialize -> tools/list handshake
bun src/cli.ts help
bun run build:bin    # cross-compile standalone binaries into dist/
                     # (Windows x64, Linux x64, macOS Intel + Apple Silicon)
```

Project layout:

```
.github/workflows/publish.yml   Release workflow: npm package + binaries
src/
  cli.ts       CLI entry point & argument parsing
  mcp.ts       MCP stdio server & tool definitions
  tools.ts     Tool implementations (shared by CLI and MCP)
  auth.ts      Browser login flow, logout, whoami
  api.ts       Typed HTTP client for the TutDub API
  upload.ts    Direct-to-S3 multipart upload (3 parallel parts, retries)
  download.ts  Result download by variant (video/audio/srt/original)
  media.ts     Duration probing (mp4/mov/m4v/m4a, wav, mp3) without ffmpeg
  config.ts    Config file + .env/env/flag resolution
test/
  config.test.ts   .env parsing and settings precedence
  core.test.ts     media probing, variants, API client
  login.test.ts    full login flow against a mock server
  upload.test.ts   multipart upload/abort against a mock server
  mcp-smoke.ts     MCP initialize + tools/list handshake
```

## Releasing

```sh
npm version patch      # bump the version, create a commit + tag (e.g. v1.0.1)
git push --follow-tags
```

Every `v*` tag triggers the `Release` workflow, which:

1. typechecks, runs the test suite and the MCP smoke test,
2. cross-compiles the standalone binaries (Windows x64, Linux x64, macOS
   Intel + Apple Silicon) and smoke-tests the Linux one,
3. publishes the npm package (skipped when that version already exists),
4. creates a GitHub Release containing the binaries and `sha256sums.txt`.

One-time setup: add an npm **automation** token as the repository secret
`NPM_TOKEN` (GitHub repo → Settings → Secrets and variables → Actions).

### Related packages

- `tutdub-server` — API (NestJS); hosts `/auth/cli/*` endpoints
- `tutdub-frontend` — web app; hosts the `/app/cli-login` authorize page
  and the token management panel on the Account page

# 881903 Live Relay

Self-hosted relay for 881903 live HLS streams. The server fetches the current upstream stream URL and required cookies internally, then serves a local `/live/*` playlist whose media resources are proxied through this app.

## Requirements

- Bun
- ffplay (for `--play`)

## Install

```bash
bun install
```

## Docker

Build and run the local server with the existing Bun + Playwright dependencies:

```bash
docker compose up --build
```

Then open:

- `http://localhost:38819/`
- `http://localhost:38819/live/903`
- `http://localhost:38819/live/881`

The server relays HLS playlists and media through opaque `/hls/*` URLs, so clients do not
see the upstream stream URL and do not need remote cookies or signed query parameters.

One-off CLI usage through Docker:

```bash
docker compose run --rm app bun run ./src/get-stream-url.ts --channel 903 --json
```

### GitHub Container Registry

This repo includes a GitHub Actions workflow that publishes the Docker image to GHCR on
pushes to `main`, version tags like `v1.0.0`, or manual workflow runs.

After pushing to your fork, the image will be available as:

```bash
ghcr.io/<your-github-user>/881903-live-url:main
```

Run the published image locally:

```bash
docker run --rm -p 38819:38819 ghcr.io/<your-github-user>/881903-live-url:main
```

## CLI Usage

Plain URL:

```bash
bun run ./src/get-stream-url.ts
```

JSON output:

```bash
bun run ./src/get-stream-url.ts --json
```

Play stream (ffplay):

```bash
bun run ./src/get-stream-url.ts --play
```

Help:

```bash
bun run ./src/get-stream-url.ts --help
```

## Server

Start the server:

```bash
bun run server
```

Endpoints:

- `GET /` Home page that shows local playback URLs.
- `GET /live/903` Returns a proxied `.m3u8` playlist for channel 903.
- `GET /live/881` Returns a proxied `.m3u8` playlist for channel 881.
- `GET /live/903?format=json` Returns JSON `{ channel, url, cached, fetchedAtMs, expiresAtMs }` where `url` is the local `/live/903` playback URL.
- `GET /live/881?format=json` Returns JSON `{ channel, url, cached, fetchedAtMs, expiresAtMs }` where `url` is the local `/live/881` playback URL.
- `GET /hls/:channel/:token` Relays playlists, media segments, and keys through server-side headers/cookies. Tokens are internal and expire with the stream cache.

Caching:

- Stream URLs are cached for 10 minutes in-memory.

## TypeScript linting

Type-check the project:

```bash
bun run lint:ts
```

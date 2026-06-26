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
- HLS resource tokens use a sliding 30-minute TTL and are refreshed while clients keep requesting playlists or segments.
- Keepalive is demand-driven: a channel starts background refresh only after `/live/*` or `/hls/*` is requested.
- Keepalive refreshes stream metadata/cookies every 2 minutes while the channel has been active within the last 15 minutes. It does not continuously download audio in the background.
- Idle channels stop keepalive automatically, and expired HLS resource tokens are pruned every 5 minutes.

Runtime knobs are available through environment variables:

- `KEEPALIVE_INTERVAL_MS` default `120000`
- `KEEPALIVE_IDLE_MS` default `900000`
- `STREAM_CACHE_TTL_MS` default `600000`
- `STREAM_FETCH_TIMEOUT_MS` default `25000`
- `HLS_RESOURCE_TTL_MS` default `1800000`
- `HLS_RESOURCE_PRUNE_INTERVAL_MS` default `300000`
- `MAX_HLS_RESOURCES` default `1000`

The Compose service also sets a 1 GB memory limit and a 256 PID limit to contain runaway browser or request behavior.

Logs:

```bash
docker compose logs -f app
```

The default `LOG_LEVEL=info` logs cache refreshes, upstream failures, and expired/missing HLS tokens. For verbose playlist and segment proxy logs, temporarily run:

```bash
LOG_LEVEL=debug docker compose up -d --build
```

## TypeScript linting

Type-check the project:

```bash
bun run lint:ts
```

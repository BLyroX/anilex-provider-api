# anileX Provider API

Small Express API written for anileX. It is designed to run on Render and keeps the upstream parser isolated in one file.

## Endpoints

- `GET /health`
- `GET /api/search/:query`
- `GET /api/anime/:id/episodes`
- `GET /api/episode?url=<episode-url>`
- `GET /api/debug/search/:query`

`/api/episode` only exposes direct HLS/MP4 links that are already present in returned HTML. It does not implement DRM, access-control, token, challenge, or anti-bot bypasses.

## Local

```bash
npm install
npm start
```

Default: `http://localhost:3005`

Examples:

```text
http://localhost:3005/api/search/naruto
http://localhost:3005/api/debug/search/naruto
```

## Render

Create a Web Service from this repo:

- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/health`

Environment variables:

```text
UPSTREAM_BASE_URL=https://aniwatch.co.at
REQUEST_TIMEOUT_MS=12000
```

No Root Directory is needed because `package.json` is at repository root.

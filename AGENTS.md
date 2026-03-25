# AGENTS.md — TikTok Video Scraper & Downloader

## What this project is
An **Apify Actor** (Node.js ESM) that fetches TikTok video metadata via the
[tikwm.com](https://www.tikwm.com) public API and optionally downloads each
video as an MP4 to the Apify Key-Value Store.

> **Important:** Despite what the README's project-structure table says, there
> is **no browser / Playwright** involved. All scraping is done via plain HTTP
> requests to `https://www.tikwm.com/api/user/posts`. The Dockerfile uses the
> lightweight `apify/actor-node:20` image (not the Playwright variant).

---

## Architecture & data flow

```
Actor.getInput()
  └─ scrapeUserVideos()   [scraper.js]   ← tikwm.com API, cursor-based pagination
       └─ normalizeVideo()               ← maps raw tikwm fields → internal shape
  └─ downloadVideo()      [downloader.js] ← axios arraybuffer GET with CDN headers
  └─ store.setValue()                    ← Apify Key-Value Store (MP4 binary)
  └─ dataset.pushData()                  ← Apify Dataset (metadata + storageUrl)
```

| File | Responsibility |
|------|----------------|
| `src/main.js` | Input validation, orchestration, Apify storage wiring |
| `src/scraper.js` | tikwm pagination, video normalization |
| `src/downloader.js` | HTTP MP4 fetch with browser-like headers |

---

## Developer workflows

```bash
# Install dependencies
npm install

# Create local input (required before running locally)
mkdir -p storage/key_value_stores/default
cat > storage/key_value_stores/default/INPUT.json << 'EOF'
{
    "profileUrls": ["https://www.tiktok.com/@tiktok"],
    "limit": 3,
    "order": "desc",
    "downloadVideos": false
}
EOF

# Run the actor locally (requires `apify-cli` and `apify login`)
apify run

# Deploy to Apify platform
apify push
```

Local output (dataset records + MP4 files) lands under `storage/`.

---

## Key conventions

- **ES Modules**: `"type": "module"` in `package.json` — always use `import`/`export`, never `require()`.
- **Logging**: use `log` from `crawlee` (`log.info`, `log.error`), not `console.log`.
- **`asc` sort is client-side**: `scraper.js` fetches up to `limit` videos (newest-first as tikwm returns them), collects all pages, then sorts by `createTime` before slicing. There is no server-side ascending pagination.
- **Video normalization filter**: items missing `id` or `video.downloadUrl` are silently dropped in `normalizeVideo()`.
- **Storage key pattern**: MP4 files are stored with key `video-<videoId>.mp4`; the public URL is built as `${APIFY_API_BASE}/v2/key-value-stores/${store.id}/records/video-<videoId>.mp4`.
- **Download resilience**: a failed download logs an error but does **not** abort the run — the record is still pushed to the dataset without `storageKey`/`storageUrl`.

---

## External dependencies & integration points

| Dependency | Purpose | Failure mode |
|------------|---------|--------------|
| `tikwm.com/api/user/posts` | Video metadata + watermark-free CDN URLs | `payload.code !== 0` → throws; empty `videos` array → stops pagination |
| TikTok CDN (`hdplay` / `play` URLs) | MP4 binary download | Requires `Referer: https://www.tiktok.com/` header — omitting it can cause 403 |
| Apify platform | Dataset, Key-Value Store, Actor input | `APIFY_API_BASE_URL` env var overrides the API base (default: `https://api.apify.com`) |

---

## Troubleshooting

- **CDN 403 errors**: check/update the `HEADERS` object in `src/downloader.js`.
- **tikwm API returns error code**: the `msg` field from the response is included in the thrown error.
- **`asc` order misses old videos on large profiles**: tikwm's API only returns recent videos; increasing `limit` is the only workaround within the current architecture.


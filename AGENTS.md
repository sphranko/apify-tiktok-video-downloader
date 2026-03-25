# AGENTS.md — TikTok Video Scraper & Downloader

## What this project is
An **Apify Actor** (Node.js ESM) that scrapes TikTok video metadata via
**[yt-dlp](https://github.com/yt-dlp/yt-dlp)** and optionally downloads each
video as an MP4 to the Apify Key-Value Store.

> **Important:** There is **no browser / Playwright** involved. All scraping is
> delegated to the `yt-dlp` CLI binary (`--dump-json --no-download`), which
> handles TikTok's API signing internally. The Dockerfile uses the lightweight
> `apify/actor-node:20` image (not the Playwright variant). `yt-dlp` must be
> installed separately when running locally.

---

## Architecture & data flow

```
Actor.getInput()
  └─ scrapeUserVideos()    [scraper.js]    ← yt-dlp --dump-json, JSONL on stdout
       └─ normalizeYtDlpItem()             ← maps yt-dlp info dict → internal shape
  └─ downloadVideo()       [downloader.js] ← yt-dlp -o <tmpfile>, returns Buffer
  └─ store.setValue()                      ← Apify Key-Value Store (MP4 binary)
  └─ dataset.pushData()                    ← Apify Dataset (metadata + storageUrl)
```

| File | Responsibility |
|------|----------------|
| `src/main.js` | Input validation, orchestration, Apify storage wiring |
| `src/scraper.js` | yt-dlp invocation, JSONL parsing, video normalisation, sorting, author filtering |
| `src/downloader.js` | yt-dlp MP4 download to `/tmp/tiktok-dl/`, returns a `Buffer` |

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

# Run the actor locally (requires `apify-cli`, `apify login`, and `yt-dlp` in PATH)
apify run

# Deploy to Apify platform
apify push
```

Local output (dataset records + MP4 files) lands under `storage/`.

---

## Key conventions

- **ES Modules**: `"type": "module"` in `package.json` — always use `import`/`export`, never `require()`.
- **Logging**: use `log` from `crawlee` (`log.info`, `log.error`), not `console.log`.
- **yt-dlp output is JSONL**: `scraper.js` calls `yt-dlp --dump-json` and parses one JSON object per stdout line. Each line is a full yt-dlp info dict.
- **`asc` sort is client-side**: `scraper.js` requests `limit × 5` items (capped at 100), sorts the raw array by `item.timestamp`, then slices to `limit`. There is no server-side ascending pagination.
- **Normalisation function**: `normalizeYtDlpItem(item)` returns `null` if `item.id` is falsy — nulls are filtered out before pushing to the dataset.
- **Author filter**: after normalisation, videos whose `authorMeta.name` does not match the requested `username` are discarded (prevents yt-dlp from returning pinned/promoted content from other accounts).
- **Storage key pattern**: MP4 files are stored with key `video-<videoId>.mp4`; the public URL is built as `${APIFY_API_BASE}/v2/key-value-stores/${store.id}/records/video-<videoId>.mp4`.
- **Download resilience**: a failed download logs an error but does **not** abort the run — the record is still pushed to the dataset without `storageKey`/`storageUrl`.
- **Temp files**: `downloader.js` writes to `/tmp/tiktok-dl/video-<id>.mp4` and deletes the file after reading it into a `Buffer`.

---

## External dependencies & integration points

| Dependency | Purpose | Failure mode |
|------------|---------|--------------|
| `yt-dlp` CLI | Profile metadata (`--dump-json`) + MP4 download | Binary must be in `PATH`; update with `pip install -U yt-dlp` when TikTok changes its API |
| TikTok platform | Video pages used by yt-dlp as input URLs | Private profiles or geo-restrictions → yt-dlp returns no items / throws |
| Apify platform | Dataset, Key-Value Store, Actor input | `APIFY_API_BASE` is hard-coded to `https://api.apify.com` (internal IP avoided) |

---

## Troubleshooting

- **yt-dlp returns no videos**: TikTok may have changed its internal API — run `pip install -U yt-dlp` (or `brew upgrade yt-dlp`) to update the binary.
- **yt-dlp download fails**: check the `stderr` message surfaced in the `log.error` output. Common causes: network timeout, unsupported format string, or a stale yt-dlp version.
- **`asc` order misses old videos on large profiles**: yt-dlp only returns recent videos; the fetch window is `limit × 5` (capped at 100). Increasing `limit` is the only workaround within the current architecture.
- **`execAsync` timeout**: default timeout is 5 minutes for scraping and 2 minutes for downloads. Increase the `timeout` option in the respective `execAsync` calls if needed.

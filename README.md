# TikTok Video Scraper & Downloader — Apify Actor

An [Apify Actor](https://apify.com/actors) that scrapes TikTok user profiles,
collects video metadata, and optionally downloads each video as an **MP4 file**
saved directly to [Apify Key-Value Store](https://docs.apify.com/platform/storage/key-value-store).

---

## Features

- Scrape one or more TikTok profile pages in a single run
- Configurable **limit** (default: 10 videos per profile)
- Configurable **sort order** — newest-first (`desc`) or oldest-first (`asc`)
- Optional MP4 **download**: files are saved to Apify storage and their public
  URL is included in the dataset output
- Resilient extraction: tries both `SIGI_STATE` and `__UNIVERSAL_DATA_STORE__`
  embedded page state, with XHR interception as a fallback

---

## Input

Configure the actor via the Apify Console or pass a JSON input directly.

| Field            | Type       | Default  | Description |
|------------------|------------|----------|-------------|
| `profileUrls`    | `string[]` | —        | **Required.** TikTok profile URLs (e.g. `https://www.tiktok.com/@username`) |
| `limit`          | `integer`  | `10`     | Maximum number of videos per profile (1–100) |
| `order`          | `string`   | `"desc"` | Sort order: `"desc"` = newest first, `"asc"` = oldest first |
| `downloadVideos` | `boolean`  | `true`   | Download MP4 files to Apify Key-Value Store |

### Example input

```json
{
    "profileUrls": [
        "https://www.tiktok.com/@tiktok"
    ],
    "limit": 5,
    "order": "desc",
    "downloadVideos": true
}
```

---

## Output

Results are pushed to the **Apify Dataset**. Each record contains:

```jsonc
{
    "id": "7380123456789012345",
    "description": "Video caption text",
    "createTime": 1714000000,
    "url": "https://www.tiktok.com/@tiktok/video/7380123456789012345",
    "author": {
        "id": "107955",
        "uniqueId": "tiktok",
        "nickname": "TikTok"
    },
    "video": {
        "playUrl":     "https://v19-webapp.tiktok.com/...",
        "downloadUrl": "https://v19-webapp.tiktok.com/...",
        "cover":       "https://p16-sign.tiktokcdn-us.com/...",
        "duration":    15,
        "width":       576,
        "height":      1024
    },
    "stats": {
        "plays":    1000000,
        "likes":    50000,
        "comments": 1200,
        "shares":   800
    },
    // Only present when downloadVideos is true and the download succeeded:
    "storageKey": "video-7380123456789012345.mp4",
    "storageUrl": "https://api.apify.com/v2/key-value-stores/<storeId>/records/video-7380123456789012345.mp4"
}
```

The `storageUrl` is a direct link to stream or download the MP4 file.

---

## Project structure

```
.actor/
  actor.json          ← Actor metadata & dataset view
  input_schema.json   ← Input schema (rendered as a form in Apify Console)
src/
  main.js             ← Entry point: input validation & orchestration
  scraper.js          ← Playwright-based profile scraper
  downloader.js       ← HTTP MP4 downloader (axios)
Dockerfile            ← Based on apify/actor-node-playwright-chrome:18
package.json
```

---

## Running locally

### Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18
- [Apify CLI](https://docs.apify.com/cli/) — `npm install -g apify-cli`

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/sphranko/apify-tiktok-video-downloader.git
cd apify-tiktok-video-downloader

# 2. Install dependencies
npm install

# 3. Log in to Apify (required for storage)
apify login

# 4. Create a local input file
mkdir -p storage/key_value_stores/default
cat > storage/key_value_stores/default/INPUT.json << 'EOF'
{
    "profileUrls": ["https://www.tiktok.com/@tiktok"],
    "limit": 3,
    "order": "desc",
    "downloadVideos": false
}
EOF

# 5. Run the actor
apify run
```

Downloaded MP4 files and dataset records will appear under `storage/` when
running locally.

---

## Deploying to Apify

```bash
# Push the actor to your Apify account and build it
apify push
```

After a successful push you can run the actor from the
[Apify Console](https://console.apify.com).

---

## Notes & limitations

- **TikTok anti-bot measures**: TikTok periodically updates its front-end and
  CDN signing logic. If scraping stops working, the page-state selectors or
  download headers in `src/scraper.js` / `src/downloader.js` may need updating.
- **Download URL expiry**: TikTok CDN URLs are time-limited. The actor downloads
  each file immediately after scraping to avoid expiry.
- **Sort order & deep pagination**: `"asc"` order works by fetching up to
  `limit × 2` videos (newest first, as TikTok provides), then reversing. For
  very large profiles this may not reach the oldest videos; increase `limit`
  accordingly.
- **Rate limiting**: Running the actor against many profiles in rapid succession
  may trigger TikTok's rate limiter. Consider adding delays between runs.

---

## License

MIT

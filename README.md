# TikTok Channel Downloader — Apify Actor

An Apify Actor that scrapes and downloads TikTok videos from any public user channel.

---

## How It Works

1. **Read input** — the actor reads the target `username`, `maxVideos`, and media download flags from the Apify input.
2. **Launch Chromium** — Playwright starts a Chromium browser with anti-bot settings (no sandbox, `AutomationControlled` disabled).
3. **Intercept API responses** — a network listener captures TikTok's internal `item_list` API calls to collect rich video metadata (stats, music, CDN URLs) before any individual video page is visited.
4. **Scroll the channel feed** — the actor scrolls `https://www.tiktok.com/@{username}` and collects unique video URLs until `maxVideos` is reached or the end of the feed is detected.
5. **Scrape each video** — for every URL, the actor navigates to the video page, merges API-intercepted data with DOM fallbacks, and builds a structured result record.
6. **Download media (optional)** — if `downloadMp4` or `downloadThumbnail` is enabled the actor fetches the binary data with `httpx` and stores it in the Apify key-value store.
7. **Push to dataset** — each result record is pushed to the Apify dataset and the public CDN URLs for any stored files are included in the record.

---

## Input

| Field | Type | Default | Required | Description |
|---|---|---|---|---|
| `username` | string | — | **yes** | TikTok username to scrape (with or without `@`) |
| `maxVideos` | integer | `20` | no | Maximum number of videos to scrape (1–500) |
| `downloadMp4` | boolean | `true` | no | Download and store the MP4 file in the key-value store |
| `downloadThumbnail` | boolean | `true` | no | Download and store the thumbnail image in the key-value store |
| `headless` | boolean | `true` | no | Run Chromium in headless mode |

---

## Output

### Dataset record example

```json
{
  "videoId": "7380123456789012345",
  "url": "https://www.tiktok.com/@charlidamelio/video/7380123456789012345",
  "username": "charlidamelio",
  "description": "wait for it 😭 #fyp",
  "date": "2024-05-15",
  "likes": 1200000,
  "comments": 4500,
  "shares": 32000,
  "views": 18500000,
  "musicTitle": "original sound - charli d'amelio",
  "musicAuthor": "charlidamelio",
  "videoPlayUrl": "https://v19-webapp.tiktok.com/...",
  "thumbnailUrl": "https://p16-sign.tiktokcdn-us.com/...",
  "mp4StorageUrl": "https://api.apify.com/v2/key-value-stores/<store-id>/records/video_7380123456789012345.mp4",
  "thumbnailStorageUrl": "https://api.apify.com/v2/key-value-stores/<store-id>/records/thumb_7380123456789012345.jpg",
  "scrapedAt": "2024-05-20T10:30:00.123456Z"
}
```

### Key-value store key patterns

| Pattern | Content |
|---|---|
| `video_{videoId}.mp4` | Downloaded MP4 video file |
| `thumb_{videoId}.jpg` | Downloaded thumbnail image |

---

## Deploy to Apify

### Option A — Apify CLI

```bash
apify login
apify push
```

### Option B — GitHub integration

1. Go to [apify.com](https://apify.com) → **Actors** → **Create new Actor**.
2. Choose **Link GitHub repository**.
3. Point to `sphranko/apify-tiktok-video-downloader`.
4. Apify will automatically build the Docker image on every push.

---

## Local Development

```bash
# Install Python dependencies
pip install -r requirements.txt

# Install Playwright browser
playwright install chromium

# Run the actor locally (Apify SDK will read input from storage/key_value_stores/default/INPUT.json)
APIFY_IS_AT_HOME=0 python -m src.main
```

Create `storage/key_value_stores/default/INPUT.json` with your test input:

```json
{
  "username": "charlidamelio",
  "maxVideos": 5,
  "downloadMp4": false,
  "downloadThumbnail": false
}
```

---

## Project Structure

```
apify-tiktok-video-downloader/
├── .actor/
│   ├── actor.json           # Actor manifest (name, version, dataset view)
│   └── input_schema.json    # Input form schema for Apify Console
├── src/
│   ├── __init__.py          # Package init
│   └── main.py              # All scraping logic
├── Dockerfile               # Apify-compatible Docker build
├── requirements.txt         # Python dependencies
└── README.md                # This file
```

---

## Important Notes

- **Anti-bot measures** — TikTok actively detects automated traffic. The actor uses a realistic Chrome user-agent, disables the `AutomationControlled` flag, and mimics human scroll behaviour, but TikTok may still block requests. Consider using [Apify residential proxies](https://docs.apify.com/platform/proxy) for improved reliability.
- **Residential proxies** — For production use, configure `proxyConfiguration` using the Apify Proxy to route requests through residential IPs. TikTok rarely serves content to datacenter IPs.
- **MP4 URL expiry** — TikTok CDN URLs for video files are time-limited (typically a few hours). The actor downloads and stores the binary immediately during the run; do not rely on `videoPlayUrl` being valid after the run completes.
- **TikTok Terms of Service** — Only use this actor to scrape publicly available content in accordance with TikTok's [Terms of Service](https://www.tiktok.com/legal/page/row/terms-of-service/en). The actor is intended for personal research and analysis only. Respect rate limits and do not use scraped data for commercial purposes without appropriate authorisation.

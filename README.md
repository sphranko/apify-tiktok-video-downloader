# TikTok Video Scraper & Downloader — Apify Actor

> **⚠️ Legal & Ethical Notice** — Read the [Policy & Compliance](#policy--compliance) section before using this tool.

An [Apify Actor](https://apify.com/actors) that collects TikTok video metadata from public user profiles and optionally downloads each video as an **MP4 file** saved to the [Apify Key-Value Store](https://docs.apify.com/platform/storage/key-value-store).

Scraping is performed entirely via **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** — no browser automation, no Playwright, no Java signer. yt-dlp handles TikTok's API signing internally, making the actor reliable from standard server IPs.

---

## Table of Contents

1. [Features](#features)
2. [Architecture](#architecture)
3. [Input](#input)
4. [Output](#output)
5. [Project Structure](#project-structure)
6. [Running Locally](#running-locally)
7. [Deploying to Apify](#deploying-to-apify)
8. [Notes & Limitations](#notes--limitations)
9. [Policy & Compliance](#policy--compliance)
10. [License](#license)

---

## Features

- Scrape **one or more** public TikTok profiles in a single run
- Configurable **video limit** per profile (default: 10, max: 100)
- Configurable **sort order** — newest-first (`desc`) or oldest-first (`asc`)
- Optional **MP4 download**: files are stored in the Apify Key-Value Store and their public URL is attached to the dataset record
- **Resilient**: a failed download logs an error but does not abort the run — the metadata record is still saved without a `storageUrl`
- **Lightweight**: uses the `apify/actor-node:20` Docker image (no Chromium)

---

## Architecture

```
Actor.getInput()
  └─ scrapeUserVideos()   [scraper.js]    ← yt-dlp --dump-json, JSONL parsing
       └─ normalizeYtDlpItem()            ← maps yt-dlp fields → internal shape
  └─ downloadVideo()      [downloader.js] ← yt-dlp -o <tmpfile>, returns Buffer
  └─ store.setValue()                     ← Apify Key-Value Store (MP4 binary)
  └─ dataset.pushData()                   ← Apify Dataset (metadata + storageUrl)
```

| File | Responsibility |
|------|----------------|
| `src/main.js` | Input validation, orchestration, Apify storage wiring |
| `src/scraper.js` | yt-dlp invocation, JSONL parsing, video normalisation, sorting |
| `src/downloader.js` | yt-dlp MP4 download → Buffer |

---

## Input

Configure the actor via the **Apify Console** or by passing a JSON input directly.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `profileUrls` | `string[]` | — | **Required.** One or more public TikTok profile URLs (e.g. `https://www.tiktok.com/@username`) |
| `limit` | `integer` | `10` | Maximum number of videos to collect per profile (1–100) |
| `order` | `string` | `"desc"` | Sort order: `"desc"` = newest first · `"asc"` = oldest first |
| `downloadVideos` | `boolean` | `true` | If `true`, download each video as MP4 and save it to the Key-Value Store |

### Example input

```json
{
    "profileUrls": [
        "https://www.tiktok.com/@tiktok"
    ],
    "limit": 5,
    "order": "desc",
    "downloadVideos": false
}
```

---

## Output

Results are pushed to the **Apify Dataset**. Each record contains:

```jsonc
{
    "id": "7380123456789012345",
    "text": "Video caption #hashtag",
    "createTimeISO": "2024-04-25T10:30:00.000Z",

    "author.name": "tiktok",
    "author.avatar": "https://www.tiktok.com/channel/tiktok",

    "playCount":    1000000,
    "diggCount":    50000,
    "commentCount": 1200,
    "shareCount":   800,
    "collectCount": 0,

    "video.duration": 15,
    "video.cover":    "https://p16-sign.tiktokcdn-us.com/...",
    "video.width":    576,
    "video.height":   1024,

    "music.musicName":     "Original Sound",
    "music.musicAuthor":   "tiktok",
    "music.musicOriginal": true,

    "webVideoUrl": "https://www.tiktok.com/@tiktok/video/7380123456789012345",

    // Only present when downloadVideos is true and the download succeeded:
    "storageKey": "video-7380123456789012345.mp4",
    "storageUrl": "https://api.apify.com/v2/key-value-stores/<storeId>/records/video-7380123456789012345.mp4"
}
```

The `storageUrl` is a direct link to stream or download the MP4 from Apify storage.

---

## Project Structure

```
src/
  main.js         ← Entry point: input validation & orchestration
  scraper.js      ← yt-dlp profile scraper & normaliser
  downloader.js   ← yt-dlp MP4 downloader → Buffer
Dockerfile        ← Based on apify/actor-node:20 (no browser)
package.json
README.md
AGENTS.md         ← Internal architecture notes for AI coding agents
```

---

## Running Locally

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| [Node.js](https://nodejs.org/) | ≥ 20 | `brew install node` |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | latest | `brew install yt-dlp` |
| [Apify CLI](https://docs.apify.com/cli/) | latest | `npm install -g apify-cli` |

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/sphranko/apify-tiktok-video-downloader.git
cd apify-tiktok-video-downloader

# 2. Install Node.js dependencies
npm install

# 3. Log in to Apify (required for local storage emulation)
apify login

# 4. Create the local input file
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

Dataset records and any downloaded MP4 files will appear under `storage/`.

---

## Deploying to Apify

```bash
# Push and build the actor on your Apify account
apify push
```

After a successful push, open the [Apify Console](https://console.apify.com) to run the actor, schedule it, or connect it to other actors via the Integration tab.

---

## Notes & Limitations

- **`asc` order is client-side**: yt-dlp returns videos newest-first. For `asc`, the actor fetches up to `limit × 5` videos (capped at 100), sorts them, and slices. On very large profiles the oldest videos may not be reachable.
- **yt-dlp updates**: TikTok regularly changes its internal API. If scraping fails, update yt-dlp (`brew upgrade yt-dlp` or `pip install -U yt-dlp`) — this usually fixes the issue.
- **Rate limiting**: sending many requests in rapid succession may trigger TikTok's rate limiter. Add delays between profile runs and avoid unusually high `limit` values.
- **Private profiles**: only publicly accessible profiles can be scraped. Private accounts or geo-restricted content will be silently skipped by yt-dlp.
- **CDN URL expiry**: yt-dlp downloads the video binary immediately during the run, so expired CDN URLs are not a concern — the MP4 is safely stored in Apify's Key-Value Store.

---

## Policy & Compliance

> **This section is important. Please read it before using this actor.**

### TikTok Terms of Service

TikTok's [Terms of Service](https://www.tiktok.com/legal/page/global/terms-of-service/en) (§ 2) explicitly **prohibit** automated data collection, scraping, crawling, or downloading of content without prior written permission from TikTok:

> *"You may not … use any robot, spider, crawler, scraper, or other automated means or interface to access the Platform or extract content."*

Using this actor against TikTok's production platform **may violate TikTok's ToS** and could result in your account or IP address being banned.

### Content Copyright

All TikTok videos are protected by copyright owned by their respective creators and/or TikTok Inc. Downloading, redistributing, or republishing videos without the original creator's explicit permission is **a potential copyright infringement** under applicable law (DMCA, EU Copyright Directive, etc.).

### Permitted & Responsible Use

This tool is provided for **educational, research, and development purposes only**. Before using it, make sure that:

- You have obtained explicit permission from the content creator(s) whose videos you are downloading.
- Your use case falls under a **lawful exemption** (e.g. academic research, journalistic use, personal archiving of your own content).
- You are **not redistributing** downloaded videos or using them commercially without the rights holder's permission.
- You comply with all applicable data-protection laws (GDPR, CCPA, etc.) — video metadata may constitute personal data.
- You only target **public profiles** and do not attempt to circumvent any access control or authentication mechanism.

### Disclaimer

The author(s) of this software provide it **"as is"**, without warranty of any kind. The author(s) are **not responsible** for any misuse, legal consequences, or ToS violations arising from the use of this tool. **You use it at your own risk.**

---

## License

[MIT](LICENSE) — see the `LICENSE` file for details.

# TikTok Video Scraper & Downloader — Apify Actor

A simple actor that collects metadata from public TikTok profiles and (optionally) saves video MP4 files to storage.

Use this actor to gather public video information from one or more TikTok profiles and — if enabled — to download the MP4 files for profiles you are allowed to access.

---

## Quick overview

- Input: one or more public TikTok profile URLs
- Output: dataset with one record per video (metadata). If downloads are enabled and succeed, each record will include a link to the saved MP4 file.
- Typical uses: data collection for research, archiving your own videos, or non-commercial analysis where you have the right to download content.

---

## How to run (Apify)

1. Open the actor in the Apify Console (or push it to your account).
2. Provide the input JSON (see example below).
3. Run the actor and inspect the dataset and key-value store results.

Example input (paste into the Apify run form):

```json
{
  "profileUrls": ["https://www.tiktok.com/@tiktok"],
  "limit": 5,
  "order": "desc",
  "downloadVideos": false
}
```

- `profileUrls`: required — list of public TikTok profile URLs
- `limit`: max number of videos to collect per profile (default: 10)
- `order`: `"desc"` (newest first) or `"asc"` (oldest first)
- `downloadVideos`: `true` or `false` — whether to save MP4 files

---

## Quick local run (for advanced users)

If you want to run the actor locally, you will need an environment with Node.js and the Apify CLI. Follow the project README or Apify documentation for local execution instructions.

---

## Output format

Each dataset record contains video metadata such as id, description, publish time, author, views/likes, and media info. When `downloadVideos` is enabled and an MP4 is successfully saved, the record includes:

- `storageKey`: internal key of the saved file
- `storageUrl`: direct link to the MP4 file in the actor's key-value store

Example (full):

```jsonc
{
  // Identifiers and text
  "id": "7380123456789012345",
  "text": "Check out this demo video! #example",
  "createTimeISO": "2024-04-25T10:30:00.000Z",

  // Author object
  "author": {
    "name": "tiktok",
    "avatar": "https://p16-sign.tiktokcdn-us.com/aweme/100x100/..." // may be empty
  },

  // Top-level numeric statistics
  "playCount": 1234567,
  "diggCount": 54321,
  "commentCount": 987,
  "shareCount": 123,
  "collectCount": 0,

  // Video metadata object
  "video": {
    "duration": 15,               // seconds
    "cover": "https://p16-sign.tiktokcdn-us.com/cover/...",
    "width": 576,
    "height": 1024
  },

  // Music / sound metadata object
  "music": {
    "name": "Original Sound",
    "author": "tiktok",
    "original": true
  },

  // Page URL for the TikTok video (always present)
  "webVideoUrl": "https://www.tiktok.com/@tiktok/video/7380123456789012345",

  // ===== Fields added when downloadVideos === true and download succeeds =====
  "storageKey": "video-7380123456789012345.mp4",
  "storageUrl": "https://api.apify.com/v2/key-value-stores/<storeId>/records/video-7380123456789012345.mp4"
}
```

Notes about optional fields:

- `author.avatar`, `music.*`, and some numeric stats may be empty or zero if yt-dlp does not provide them for a particular video.
- `storageKey` and `storageUrl` appear only when `downloadVideos` is enabled and the MP4 download succeeded; otherwise those fields are omitted.
- Always validate presence of fields before using them in downstream processing.

---

## Policy (short)

Please read and follow these rules before using the actor:

- Respect TikTok's Terms of Service — automated scraping may violate their terms and can lead to bans or other penalties.
- Do not download or redistribute videos unless you have the rights or permission from the content owner.
- Use the actor only for lawful, ethical purposes (research, archiving your own content, or other permitted uses).

This actor is provided "as is". The maintainers are not responsible for legal consequences arising from misuse.

---

## Support & contributions

If you find issues or want to suggest improvements, open an issue or a pull request in the repository.

---

## License

MIT — see the `LICENSE` file for details.

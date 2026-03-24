/**
 * @file downloader.js
 * @description Downloads TikTok MP4 video files via HTTP.
 *
 * TikTok's CDN requires browser-like request headers (notably `Referer` and
 * `User-Agent`) and follows one or more redirects before serving the binary
 * payload. `axios` is used with `responseType: 'arraybuffer'` to handle
 * the full binary response in memory before saving it to Apify storage.
 */

import axios from 'axios';
import { log } from 'crawlee';

/** Maximum time (ms) to wait for a single video download. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Maximum number of redirects to follow. */
const MAX_REDIRECTS = 10;

/**
 * Browser-like request headers required by TikTok's CDN.
 * Omitting `Referer` causes many download URLs to return 403.
 */
const DOWNLOAD_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        + 'AppleWebKit/537.36 (KHTML, like Gecko) '
        + 'Chrome/124.0.0.0 Safari/537.36',
    'Referer':         'https://www.tiktok.com/',
    'Origin':          'https://www.tiktok.com',
    'Accept':          'video/webm,video/ogg,video/*;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Sec-Fetch-Dest':  'video',
    'Sec-Fetch-Mode':  'no-cors',
    'Sec-Fetch-Site':  'cross-site',
    /**
     * `Range: bytes=0-` tells the CDN we accept the full file but want it
     * served as a seekable range response, which some TikTok CDN nodes require
     * to start streaming from the beginning.
     */
    'Range': 'bytes=0-',
};

/**
 * Downloads a TikTok video from the given URL and returns its contents as a
 * Node.js `Buffer`.
 *
 * @param {string} url      - The direct MP4 / CDN download URL for the video.
 * @param {string} videoId  - The TikTok video ID, used only for log messages.
 * @returns {Promise<Buffer>} The raw MP4 file contents.
 * @throws {Error} When the HTTP request fails or times out.
 */
export async function downloadVideo(url, videoId) {
    log.info(`[${videoId}] Downloading from CDN...`);

    const response = await axios.get(url, {
        responseType:   'arraybuffer',
        headers:        DOWNLOAD_HEADERS,
        maxRedirects:   MAX_REDIRECTS,
        timeout:        DOWNLOAD_TIMEOUT_MS,
        // Accept both 200 OK and 206 Partial Content (range request response).
        validateStatus: (status) => status === 200 || status === 206,
    });

    const buffer = Buffer.from(response.data);
    log.info(`[${videoId}] Download complete — ${(buffer.length / 1_048_576).toFixed(2)} MB`);
    return buffer;
}

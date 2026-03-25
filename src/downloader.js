/**
 * @file downloader.js
 * @description Downloads a TikTok MP4 from a direct CDN URL.
 *
 * TikTok's CDN URLs (playAddr field) are watermark-free but require the
 * original browser session cookies to be forwarded — otherwise the CDN
 * returns 403. The caller must pass the `cookies` string captured by the
 * Playwright session in scraper.js.
 */

import axios from 'axios';
import { log } from 'crawlee';

/** Maximum time (ms) to wait for a single video download. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Browser-like request headers required by TikTok's CDN.
 * The Cookie header is merged in at call time.
 */
const BASE_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        + 'AppleWebKit/537.36 (KHTML, like Gecko) '
        + 'Chrome/124.0.0.0 Safari/537.36',
    'Referer':         'https://www.tiktok.com/',
    'Origin':          'https://www.tiktok.com',
    'Accept':          'video/webm,video/ogg,video/*;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Range':           'bytes=0-',
};

/**
 * Downloads a TikTok video from a direct CDN URL and returns its contents
 * as a Node.js `Buffer`.
 *
 * @param {string} downloadUrl - Direct CDN URL for the video (from `playAddr`).
 * @param {string} videoId     - TikTok video ID, used only for log messages.
 * @param {string} [cookies]   - Raw Cookie header string from the Playwright
 *   browser session. Required for the CDN to accept the request.
 * @returns {Promise<Buffer>} Raw MP4 file contents.
 * @throws {Error} If the HTTP request fails or times out.
 */
export async function downloadVideo(downloadUrl, videoId, cookies = '') {
    log.info(`[${videoId}] Downloading MP4...`);

    const headers = {
        ...BASE_HEADERS,
        ...(cookies ? { Cookie: cookies } : {}),
    };

    const response = await axios.get(downloadUrl, {
        responseType:   'arraybuffer',
        headers,
        timeout:        DOWNLOAD_TIMEOUT_MS,
        maxRedirects:   10,
        validateStatus: (status) => status === 200 || status === 206,
    });

    const buffer = Buffer.from(response.data);
    log.info(
        `[${videoId}] Download complete — ${(buffer.length / 1_048_576).toFixed(2)} MB`,
    );
    return buffer;
}

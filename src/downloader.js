/**
 * @file downloader.js
 * @description Downloads a TikTok MP4 from a direct CDN URL.
 *
 * The download URLs are provided by the tikwm.com API (fields `hdplay` /
 * `play`) and point directly to TikTok's CDN without any watermark.
 * A standard HTTP GET with browser-like headers is sufficient to fetch them.
 */

import axios from 'axios';
import { log } from 'crawlee';

/** Maximum time (ms) to wait for a single video download. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Minimal browser-like headers to satisfy TikTok's CDN.
 * Omitting `Referer` can cause 403 responses on some CDN nodes.
 */
const HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        + 'AppleWebKit/537.36 (KHTML, like Gecko) '
        + 'Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://www.tiktok.com/',
    'Origin':  'https://www.tiktok.com',
};

/**
 * Downloads a TikTok video from a direct CDN URL and returns its raw
 * contents as a Node.js `Buffer`.
 *
 * @param {string} downloadUrl - Direct MP4 / CDN URL (from tikwm `hdplay` or
 *   `play` field).
 * @param {string} videoId - TikTok video ID, used only for log messages.
 * @returns {Promise<Buffer>} Raw MP4 file contents.
 * @throws {Error} If the HTTP request fails or times out.
 */
export async function downloadVideo(downloadUrl, videoId) {
    log.info(`[${videoId}] Downloading MP4...`);

    const response = await axios.get(downloadUrl, {
        responseType:   'arraybuffer',
        headers:        HEADERS,
        timeout:        DOWNLOAD_TIMEOUT_MS,
        maxRedirects:   10,
        validateStatus: (status) => status >= 200 && status < 300,
    });

    const buffer = Buffer.from(response.data);
    log.info(
        `[${videoId}] Download complete — ${(buffer.length / 1_048_576).toFixed(2)} MB`,
    );
    return buffer;
}

/**
 * @file downloader.js
 * @description Downloads a TikTok video MP4 using yt-dlp.
 *
 * yt-dlp handles TikTok CDN authentication and signing internally,
 * so no browser cookies or special headers are required.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink, mkdir } from 'node:fs/promises';
import { log } from 'crawlee';

const execAsync = promisify(execFile);

/** Directory for temporary video files. */
const TMP_DIR = '/tmp/tiktok-dl';

/**
 * Downloads a TikTok video from its page URL and returns the MP4 as a Buffer.
 *
 * @param {string} videoPageUrl - TikTok video page URL
 *   (e.g. `https://www.tiktok.com/@user/video/123`).
 * @param {string} videoId - Video ID, used for the temp file name and logging.
 * @returns {Promise<Buffer>} Raw MP4 file contents.
 * @throws {Error} If yt-dlp fails or the file cannot be read.
 */
export async function downloadVideo(videoPageUrl, videoId, { cookiesFile = null } = {}) {
    await mkdir(TMP_DIR, { recursive: true });

    const outputPath = `${TMP_DIR}/video-${videoId}.mp4`;
    log.info(`[${videoId}] Downloading MP4 via yt-dlp...`);

    const args = [
        '-o', outputPath,
        '--format', 'best[ext=mp4]/best',
        '--no-warnings',
        '--no-check-certificates',
        '--extractor-args', 'tiktok:app_name=musical_ly',
    ];

    if (cookiesFile) {
        args.push('--cookies', cookiesFile);
    }

    args.push(videoPageUrl);

    try {
        await execAsync('yt-dlp', args, { timeout: 120_000 });
    } catch (err) {
        const msg = err.stderr?.trim() || err.message;
        throw new Error(`yt-dlp download failed for ${videoId}: ${msg}`);
    }

    const buffer = await readFile(outputPath);
    await unlink(outputPath).catch(() => {});

    log.info(
        `[${videoId}] Download complete — ${(buffer.length / 1_048_576).toFixed(2)} MB`,
    );
    return buffer;
}

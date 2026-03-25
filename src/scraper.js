/**
 * @file scraper.js
 * @description TikTok profile video scraper using yt-dlp.
 *
 * yt-dlp handles TikTok's API signing internally (same approach as dltik),
 * making it reliable from datacenter IPs without any browser or Java signer.
 *
 * Flow:
 *  1. Call `yt-dlp --dump-json --no-download` on the profile URL.
 *  2. yt-dlp fetches the profile page, extracts secUid, signs the API call,
 *     and returns full metadata for each video as JSONL on stdout.
 *  3. Normalise the yt-dlp output into a shape similar to clockworks' output.
 *  4. Sort by timestamp and apply limit.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from 'crawlee';

const execAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the TikTok username from a profile URL.
 * @param {string} url
 * @returns {string}
 */
function extractUsername(url) {
    const match = url.match(/@([^/?#]+)/);
    if (!match) throw new Error(`Cannot extract username from URL: ${url}`);
    return match[1];
}

/**
 * Normalises a single yt-dlp JSON info dict into the actor's output shape.
 * Field names are modelled after clockworks' output so consumers can switch
 * between actors with minimal changes.
 *
 * @param {Object} item - A parsed yt-dlp info dict.
 * @returns {Object|null}
 */
function normalizeYtDlpItem(item) {
    if (!item?.id) return null;

    const timestamp = Number(item.timestamp ?? 0);

    return {
        id:             String(item.id),
        text:           String(item.description ?? item.title ?? ''),
        createTimeISO:  timestamp ? new Date(timestamp * 1000).toISOString() : null,
        createTime:     timestamp,

        // Author
        'authorMeta.name':   String(item.uploader ?? item.uploader_id ?? ''),
        'authorMeta.avatar': '',  // yt-dlp doesn't provide avatar URLs

        // Stats
        playCount:    Number(item.view_count    ?? 0),
        diggCount:    Number(item.like_count    ?? 0),
        commentCount: Number(item.comment_count ?? 0),
        shareCount:   Number(item.repost_count  ?? 0),
        collectCount: 0,

        // Video metadata
        'videoMeta.duration': Number(item.duration ?? 0),

        // Music metadata
        'musicMeta.musicName':     String(item.track    ?? ''),
        'musicMeta.musicAuthor':   String(item.artist   ?? ''),
        'musicMeta.musicOriginal': false,

        // URLs
        webVideoUrl: String(
            item.webpage_url
            ?? `https://www.tiktok.com/@${item.uploader}/video/${item.id}`,
        ),
    };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrapes video metadata from a TikTok profile using yt-dlp.
 *
 * @param {string} profileUrl - Full TikTok profile URL.
 * @param {Object} [options]
 * @param {number} [options.limit=10]
 * @param {string} [options.order='desc']
 * @returns {Promise<{ videos: Object[] }>}
 */
export async function scrapeUserVideos(profileUrl, { limit = 10, order = 'desc' } = {}) {
    const username = extractUsername(profileUrl);
    log.info(`[scraper] Fetching videos for @${username} (limit: ${limit}, order: ${order})`);

    // For descending (newest first) we only need `limit` items.
    // For ascending we fetch a larger window so we can sort and take the oldest.
    const fetchCount = order === 'asc' ? Math.min(limit * 5, 100) : limit;

    let stdout;
    try {
        const result = await execAsync('yt-dlp', [
            '--dump-json',
            '--no-download',
            '--no-warnings',
            '--no-check-certificates',
            '--playlist-items', `1:${fetchCount}`,
            profileUrl,
        ], {
            maxBuffer: 100 * 1024 * 1024,  // 100 MB
            timeout:   300_000,             // 5 min
        });
        stdout = result.stdout;
    } catch (err) {
        const msg = err.stderr?.trim() || err.message;
        throw new Error(`yt-dlp failed for @${username}: ${msg}`);
    }

    // yt-dlp outputs one JSON object per line (JSONL).
    const rawItems = stdout.trim().split('\n')
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);

    log.info(`[scraper] yt-dlp returned ${rawItems.length} video(s) for @${username}.`);

    // Normalise and filter to only this user's content.
    const videos = rawItems
        .map(normalizeYtDlpItem)
        .filter((v) => {
            if (!v) return false;
            const author = v['authorMeta.name'].toLowerCase();
            return !author || author === username.toLowerCase();
        });

    // Sort by creation timestamp.
    videos.sort((a, b) =>
        order === 'asc'
            ? a.createTime - b.createTime
            : b.createTime - a.createTime,
    );

    return { videos: videos.slice(0, limit) };
}

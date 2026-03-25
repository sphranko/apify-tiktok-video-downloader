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

    // Thumbnail: yt-dlp provides the video cover, not the author avatar.
    const thumbnail = item.thumbnail
        ?? item.thumbnails?.[0]?.url
        ?? '';

    return {
        id:             String(item.id),
        text:           String(item.description ?? item.title ?? ''),
        createTimeISO:  timestamp ? new Date(timestamp * 1000).toISOString() : null,

        // Author (simplified)
        author: {
            name:   String(item.uploader ?? item.uploader_id ?? ''),
            avatar: String(item.channel_url ?? ''),
        },

        // Stats (kept flat for compatibility)
        playCount:    Number(item.view_count    ?? 0),
        diggCount:    Number(item.like_count    ?? 0),
        commentCount: Number(item.comment_count ?? 0),
        shareCount:   Number(item.repost_count  ?? 0),
        collectCount: 0,

        // Video metadata (simplified)
        video: {
            duration: Number(item.duration ?? 0),
            cover:    String(thumbnail),
            width:    Number(item.width  ?? 0),
            height:   Number(item.height ?? 0),
        },

        // Music metadata (simplified)
        music: {
            name:     String(item.track  ?? ''),
            author:   String(item.artist ?? ''),
            original: Boolean(item.artist && item.uploader
                && item.artist.toLowerCase() === item.uploader.toLowerCase()),
        },

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
export async function scrapeUserVideos(profileUrl, { limit = 10, order = 'desc', cookiesFile = null } = {}) {
    const username = extractUsername(profileUrl);
    log.info(`[scraper] Fetching videos for @${username} (limit: ${limit}, order: ${order})`);

    // Fetch extra items to compensate for videos that yt-dlp skips (deleted,
    // private, region-locked). The buffer is capped so we don't over-fetch.
    const SKIP_BUFFER = 5;
    const fetchCount = order === 'asc'
        ? Math.min(limit * 5, 100)
        : Math.min(limit + SKIP_BUFFER, 100);

    const args = [
        '--dump-json',
        '--no-download',
        '--no-warnings',
        '--no-check-certificates',
        '--ignore-errors',
        '--extractor-args', 'tiktok:app_name=musical_ly',
        '--playlist-items', `1:${fetchCount}`,
    ];

    if (cookiesFile) {
        args.push('--cookies', cookiesFile);
    }

    args.push(profileUrl);

    let stdout;
    try {
        const result = await execAsync('yt-dlp', args, {
            maxBuffer: 100 * 1024 * 1024,  // 100 MB
            timeout:   300_000,             // 5 min
        });
        stdout = result.stdout;
    } catch (err) {
        // With --ignore-errors, yt-dlp exits non-zero only if ALL items failed.
        // If we got any stdout, try to use it before giving up.
        if (err.stdout?.trim()) {
            stdout = err.stdout;
        } else {
            const msg = err.stderr?.trim() || err.message;
            throw new Error(`yt-dlp failed for @${username}: ${msg}`);
        }
    }

    // yt-dlp outputs one JSON object per line (JSONL).
    const rawItems = stdout.trim().split('\n')
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);

    log.info(`[scraper] yt-dlp returned ${rawItems.length} video(s) for @${username}.`);

    // Sort raw items by timestamp before normalising so we can slice correctly.
    rawItems.sort((a, b) => {
        const ta = Number(a.timestamp ?? 0);
        const tb = Number(b.timestamp ?? 0);
        return order === 'asc' ? ta - tb : tb - ta;
    });

    // Normalise and filter to only this user's content.
    const videos = rawItems
        .map(normalizeYtDlpItem)
        .filter((v) => {
            if (!v) return false;
            const author = (v.author?.name ?? '').toLowerCase();
            return !author || author === username.toLowerCase();
        });

    return { videos: videos.slice(0, limit) };
}

/**
 * @file scraper.js
 * @description Fetches TikTok video metadata via the tikwm.com public API.
 *
 * tikwm.com mirrors TikTok's internal API and returns pre-resolved,
 * watermark-free CDN URLs in the response — no browser automation needed.
 *
 * API endpoint used:
 *   GET https://www.tikwm.com/api/user/posts
 *   Params: unique_id, count (max 35), cursor, hd
 *
 * Pagination: the response includes a `cursor` value and a `hasMore` flag.
 * We keep fetching pages until we have enough videos or TikTok has no more.
 */

import axios from 'axios';
import { log } from 'crawlee';

/** tikwm.com base URL. */
const TIKWM_BASE = 'https://www.tikwm.com';

/** Maximum videos per page supported by tikwm. */
const PAGE_SIZE = 35;

/** HTTP timeout for tikwm API requests (ms). */
const API_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the TikTok username from a profile URL.
 *
 * @param {string} url - e.g. `https://www.tiktok.com/@username`
 * @returns {string} Username without the leading `@`.
 * @throws {Error} If no username segment is found.
 */
function extractUsername(url) {
    const match = url.match(/@([^/?#]+)/);
    if (!match) throw new Error(`Cannot extract username from URL: ${url}`);
    return match[1];
}

/**
 * Normalises a raw tikwm video item into the internal shape used by main.js
 * and downloader.js.
 *
 * @param {Object} item - Raw video object from tikwm `/api/user/posts`.
 * @returns {Object} Normalised video descriptor.
 */
function normalizeVideo(item) {
    const author = item.author ?? {};

    return {
        id:          String(item.video_id ?? item.id ?? ''),
        description: String(item.title ?? ''),
        createTime:  Number(item.create_time ?? 0),

        author: {
            id:       String(author.id ?? ''),
            uniqueId: String(author.unique_id ?? ''),
            nickname: String(author.nickname ?? ''),
        },

        video: {
            // Prefer HD watermark-free stream; fall back to standard play URL.
            downloadUrl: String(item.hdplay ?? item.play ?? ''),
            cover:       String(item.origin_cover ?? item.cover ?? ''),
            duration:    Number(item.duration ?? 0),
            width:       Number(item.width  ?? 0),
            height:      Number(item.height ?? 0),
        },

        stats: {
            plays:    Number(item.play_count    ?? 0),
            likes:    Number(item.digg_count    ?? 0),
            comments: Number(item.comment_count ?? 0),
            shares:   Number(item.share_count   ?? 0),
        },

        // Canonical TikTok watch URL (for reference in the dataset).
        url: `https://www.tiktok.com/@${author.unique_id ?? ''}/video/${item.video_id ?? item.id ?? ''}`,
    };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetches videos from a TikTok user profile using the tikwm.com API.
 *
 * @param {string} profileUrl - Full TikTok profile URL
 *   (e.g. `https://www.tiktok.com/@username`).
 * @param {Object} [options]              - Options.
 * @param {number} [options.limit=10]     - Maximum videos to return.
 * @param {string} [options.order='desc'] - `'desc'` for newest-first,
 *   `'asc'` for oldest-first.
 * @returns {Promise<Object[]>} Sorted and limited array of normalised video
 *   descriptors.
 * @throws {Error} If the API call fails or returns a non-zero error code.
 */
export async function scrapeUserVideos(profileUrl, { limit = 10, order = 'desc' } = {}) {
    const username = extractUsername(profileUrl);
    const videos   = [];
    let cursor     = 0;

    log.info(`[scraper] Fetching videos for @${username} (limit: ${limit}, order: ${order})`);

    while (videos.length < limit) {
        // tikwm requires POST with application/x-www-form-urlencoded body.
        const body = new URLSearchParams({
            unique_id: `@${username}`,
            count:     String(PAGE_SIZE),
            cursor:    String(cursor),
            hd:        '1',
        });

        const response = await axios.post(`${TIKWM_BASE}/api/user/posts`, body, {
            headers: {
                'Content-Type':    'application/x-www-form-urlencoded',
                'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Referer':         'https://www.tikwm.com/',
                'Origin':          'https://www.tikwm.com',
                'Accept':          'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            timeout: API_TIMEOUT_MS,
        });

        const payload = response.data;

        if (payload.code !== 0) {
            throw new Error(
                `tikwm API returned error code ${payload.code}: ${payload.msg ?? 'unknown error'}`,
            );
        }

        const items = payload.data?.videos ?? [];

        if (!items.length) {
            log.info(`[scraper] No more videos returned by API (cursor: ${cursor}).`);
            break;
        }

        for (const item of items) {
            const v = normalizeVideo(item);
            if (v.id && v.video.downloadUrl) videos.push(v);
        }

        log.info(
            `[scraper] Page fetched — got ${items.length} item(s), `
            + `total so far: ${videos.length}`,
        );

        if (!payload.data?.hasMore) break;

        cursor = payload.data.cursor;
    }

    log.info(`[scraper] Collection complete — ${videos.length} video(s) before sort/limit.`);

    videos.sort((a, b) =>
        order === 'asc'
            ? a.createTime - b.createTime
            : b.createTime - a.createTime,
    );

    return videos.slice(0, limit);
}

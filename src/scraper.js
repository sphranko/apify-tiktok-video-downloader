/**
 * @file scraper.js
 * @description TikTok profile scraper using CheerioCrawler (HTTP-only).
 *
 * Strategy:
 *  1. Perform a plain GET request to the TikTok profile URL with realistic
 *     browser headers so TikTok's SSR serves the full HTML page.
 *  2. Parse the `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">` tag embedded
 *     in the HTML — it contains the first batch of profile videos as JSON,
 *     no JavaScript execution required.
 *  3. Fall back to the legacy `<script id="SIGI_STATE">` tag if needed.
 *  4. Sort by creation timestamp and apply the caller-supplied limit.
 *
 * Why CheerioCrawler instead of Playwright:
 *  TikTok detects headless browsers and serves a stripped-down page without
 *  the embedded video data. Plain HTTP requests with browser-like headers
 *  bypass this detection and receive the full SSR payload.
 *
 * Pagination note:
 *  The SSR payload typically contains the latest ~30 videos. Fetching beyond
 *  that requires TikTok's signed API (Java-based MetaSec signing used by
 *  third-party actors). For the default limit of 10 this is sufficient.
 */

import { CheerioCrawler, log } from 'crawlee';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Headers that mimic a real Chrome browser on Windows.
 * These are required for TikTok's CDN/SSR to serve the full HTML payload.
 */
const BROWSER_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        + 'AppleWebKit/537.36 (KHTML, like Gecko) '
        + 'Chrome/124.0.0.0 Safari/537.36',
    'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,'
        + 'image/avif,image/webp,image/apng,*/*;q=0.8,'
        + 'application/signed-exchange;v=b3;q=0.7',
    'Accept-Language':          'en-US,en;q=0.9',
    'Accept-Encoding':          'gzip, deflate, br',
    'Cache-Control':            'max-age=0',
    'Sec-Ch-Ua':                '"Not_A Brand";v="8", "Chromium";v="124", "Google Chrome";v="124"',
    'Sec-Ch-Ua-Mobile':         '?0',
    'Sec-Ch-Ua-Platform':       '"Windows"',
    'Sec-Fetch-Dest':           'document',
    'Sec-Fetch-Mode':           'navigate',
    'Sec-Fetch-Site':           'none',
    'Sec-Fetch-User':           '?1',
    'Upgrade-Insecure-Requests': '1',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the TikTok username from a profile URL.
 * @param {string} url - e.g. `https://www.tiktok.com/@username`
 * @returns {string} Username without the leading `@`.
 */
function extractUsername(url) {
    const match = url.match(/@([^/?#]+)/);
    if (!match) throw new Error(`Cannot extract username from URL: ${url}`);
    return match[1];
}

/**
 * Normalises a raw TikTok API video item into the internal shape.
 * Handles both the web format (playAddr, stats.*Count) and the legacy
 * aweme/mobile format (play_addr.url_list, statistics.*_count).
 *
 * @param {Object} item - Raw video item from TikTok's embedded page state.
 * @returns {Object|null} Normalised video descriptor, or null if unusable.
 */
function normalizeVideoItem(item) {
    if (!item || typeof item !== 'object') return null;

    const isAweme = Boolean(item.aweme_id);
    const author  = item.author     ?? {};
    const video   = item.video      ?? {};
    const stats   = item.stats      ?? item.statistics ?? {};

    const id = String(isAweme ? (item.aweme_id ?? '') : (item.id ?? ''));
    if (!id) return null;

    // createTime from TikTok is Unix seconds; multiply by 1000 for JS Date.
    const createTimeSec = Number(
        isAweme ? (item.create_time ?? 0) : (item.createTime ?? 0),
    );

    const playUrl =
        video.playAddr                    ??
        video.play_addr?.url_list?.[0]    ??
        video.downloadAddr                ??
        video.download_addr?.url_list?.[0] ??
        '';

    const isPinned = Boolean(isAweme ? (item.is_top ?? 0) : (item.isTop ?? 0));

    const toNum = (v) => Number(v ?? 0);

    return {
        id,
        isPinned,
        description: String(item.desc ?? ''),
        createTime:  createTimeSec,
        createDate:  createTimeSec ? new Date(createTimeSec * 1000).toISOString() : null,
        author: {
            id:       String(author.uid       ?? author.id    ?? item.authorId ?? ''),
            uniqueId: String(author.unique_id ?? author.uniqueId ?? ''),
            nickname: String(author.nickname  ?? ''),
        },
        video: {
            downloadUrl: playUrl ? String(playUrl) : '',
            cover:       String(video.cover ?? video.origin_cover ?? ''),
            duration:    Number(video.duration ?? 0),
            width:       Number(video.width    ?? 0),
            height:      Number(video.height   ?? 0),
        },
        stats: {
            plays:    toNum(stats.playCount    ?? stats.play_count),
            likes:    toNum(stats.diggCount    ?? stats.digg_count),
            comments: toNum(stats.commentCount ?? stats.comment_count),
            shares:   toNum(stats.shareCount   ?? stats.share_count),
        },
    };
}

/**
 * Extracts a video item list from TikTok's embedded page-state JSON.
 *
 * @param {Object} pageData - Parsed JSON from the embedded script tag.
 * @returns {Object[]} Array of raw item objects (may be empty).
 */
function extractItemListFromPageData(pageData) {
    if (!pageData || typeof pageData !== 'object') return [];

    const scope = pageData.__DEFAULT_SCOPE__ ?? {};

    // Current TikTok format (webapp.user-post or webapp.video-user)
    const fromScope =
        scope?.['webapp.user-post']?.itemList  ??
        scope?.['webapp.video-user']?.itemList ??
        null;
    if (Array.isArray(fromScope) && fromScope.length > 0) return fromScope;

    // Legacy SIGI_STATE format (ItemModule is an object keyed by video ID)
    if (pageData.ItemModule && typeof pageData.ItemModule === 'object') {
        const items = Object.values(pageData.ItemModule);
        if (items.length > 0) return items;
    }

    // Flat itemList at root (some API response shapes)
    if (Array.isArray(pageData.itemList) && pageData.itemList.length > 0) {
        return pageData.itemList;
    }

    return [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrapes videos from a TikTok user profile page.
 *
 * Uses `CheerioCrawler` (HTTP-only) to fetch the profile page HTML and parse
 * the SSR-embedded video list — no browser required.
 *
 * @param {string} profileUrl - Full TikTok profile URL.
 * @param {Object} [options]              - Scraping options.
 * @param {number} [options.limit=10]     - Maximum videos to return.
 * @param {string} [options.order='desc'] - `'desc'` newest-first, `'asc'` oldest-first.
 * @returns {Promise<{ videos: Object[], cookies: string }>}
 *   `videos`  — sorted and limited array of normalised video descriptors.
 *   `cookies` — empty string (no browser session; kept for API compatibility).
 */
export async function scrapeUserVideos(profileUrl, { limit = 10, order = 'desc' } = {}) {
    const username = extractUsername(profileUrl);
    const videoMap = new Map();

    const crawler = new CheerioCrawler({
        maxRequestsPerCrawl: 1,

        // Ignore non-HTML MIME types that might be encountered.
        additionalMimeTypes: ['application/json'],

        async requestHandler({ $ }) {
            // ── Step 1: Extract the embedded page-state JSON ──────────────────
            // TikTok's SSR injects the first batch of profile videos into one of
            // these script elements as a JSON string.
            const scriptText =
                $('script#__UNIVERSAL_DATA_FOR_REHYDRATION__').html() ??
                $('script#SIGI_STATE').html()                          ??
                '';

            if (!scriptText.trim()) {
                log.warning(
                    `[${username}] No embedded state found. TikTok may be blocking `
                    + 'the request or the page structure has changed.',
                );
                return;
            }

            let pageData;
            try {
                pageData = JSON.parse(scriptText);
            } catch (err) {
                log.error(`[${username}] Failed to parse embedded state: ${err.message}`);
                return;
            }

            // ── Step 2: Normalise items and deduplicate ────────────────────────
            const rawItems = extractItemListFromPageData(pageData);
            log.info(`[${username}] Embedded state: ${rawItems.length} raw item(s).`);

            for (const raw of rawItems) {
                const v = normalizeVideoItem(raw);
                if (!v) continue;

                // Only keep videos that belong to the requested profile.
                if (
                    v.author.uniqueId
                    && v.author.uniqueId.toLowerCase() !== username.toLowerCase()
                ) continue;

                videoMap.set(v.id, v);
            }

            log.info(`[${username}] Collected ${videoMap.size} own video(s).`);
        },
    });

    await crawler.run([{
        url:     profileUrl,
        headers: BROWSER_HEADERS,
    }]);

    // ── Sort by creation date and apply limit ─────────────────────────────────
    const videos = Array.from(videoMap.values());
    videos.sort((a, b) =>
        order === 'asc'
            ? a.createTime - b.createTime
            : b.createTime - a.createTime,
    );

    const result = videos.slice(0, limit);
    for (const v of result) {
        v.url = `https://www.tiktok.com/@${v.author.uniqueId}/video/${v.id}`;
    }

    // cookies is empty — CheerioCrawler has no browser session.
    // downloader.js will attempt the CDN request without session cookies.
    return { videos: result, cookies: '' };
}

/**
 * @file scraper.js
 * @description TikTok profile scraper using Playwright via Crawlee.
 *
 * Strategy:
 *  1. Disable Chromium automation fingerprinting flags so TikTok renders real content.
 *  2. Intercept ALL JSON responses from *.tiktok.com and extract any that contain
 *     a video list (field names vary between TikTok's web and mobile API versions).
 *  3. After navigation, also read the initial video batch from the embedded page
 *     state (<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"> or SIGI_STATE).
 *  4. Scroll until enough videos are collected or no new ones appear.
 */

import { PlaywrightCrawler, log } from 'crawlee';

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
 * Normalises a raw TikTok video item from either the web API or the mobile
 * (aweme) API into a consistent internal shape.
 *
 * Web API fields:  id, desc, createTime, author.uniqueId, video.playAddr,
 *                  video.downloadAddr, stats.*Count
 * Mobile API fields: aweme_id, desc, create_time, author.unique_id,
 *                    video.play_addr.url_list, video.download_addr.url_list,
 *                    statistics.*_count
 *
 * @param {Object} item - Raw video item from any TikTok API version.
 * @returns {Object} Normalised video descriptor.
 */
function normalizeVideoItem(item) {
    const isAweme  = Boolean(item.aweme_id); // mobile API format
    const author   = item.author   ?? {};
    const video    = item.video    ?? {};
    const stats    = item.stats    ?? item.statistics ?? {};

    // Pick the no-watermark play URL — prefer web playAddr / aweme play_addr.
    const playUrl =
        video.playAddr ??
        video.play_addr?.url_list?.[0] ??
        '';

    const downloadUrl =
        video.downloadAddr ??
        video.download_addr?.url_list?.[0] ??
        playUrl;

    return {
        id:          String(isAweme ? item.aweme_id : (item.id ?? '')),
        description: String(item.desc ?? ''),
        createTime:  Number(isAweme ? item.create_time : (item.createTime ?? 0)),

        author: {
            id:       String(author.uid     ?? author.id   ?? item.authorId ?? ''),
            uniqueId: String(author.unique_id ?? author.uniqueId ?? ''),
            nickname: String(author.nickname  ?? ''),
        },

        video: {
            downloadUrl: String(downloadUrl),
            cover:       String(video.cover ?? video.origin_cover ?? ''),
            duration:    Number(video.duration ?? 0),
            width:       Number(video.width    ?? 0),
            height:      Number(video.height   ?? 0),
        },

        stats: {
            plays:    Number(stats.playCount    ?? stats.play_count    ?? 0),
            likes:    Number(stats.diggCount    ?? stats.digg_count    ?? 0),
            comments: Number(stats.commentCount ?? stats.comment_count ?? 0),
            shares:   Number(stats.shareCount   ?? stats.share_count   ?? 0),
        },
    };
}

/**
 * Tries to extract a video list from an arbitrary parsed JSON object returned
 * by any TikTok API endpoint.
 *
 * @param {Object} data - Parsed JSON from a TikTok API response.
 * @returns {Object[]} Array of normalised video items (may be empty).
 */
function extractItemsFromApiResponse(data) {
    const list =
        data?.itemList      ??  // web /api/post/item_list/
        data?.aweme_list    ??  // mobile aweme API
        data?.items         ??  // some variants
        data?.data?.itemList ??
        data?.data?.aweme_list ??
        null;

    if (Array.isArray(list) && list.length) {
        return list.map(normalizeVideoItem).filter((v) => v.id && v.video.downloadUrl);
    }
    return [];
}

/**
 * Tries to extract the initial video batch from the TikTok page's embedded
 * JSON state (runs inside the browser via page.evaluate).
 *
 * @returns {Object[]|null} Raw parsed objects found on the page, or null.
 */
function buildPageStateExtractor() {
    // This function body is serialised and executed inside the browser.
    return () => {
        const results = [];

        function tryPush(text) {
            if (!text || text.length < 50) return;
            try { results.push(JSON.parse(text.trim())); } catch { /* ignore */ }
        }

        // Strategy A: <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">
        tryPush(
            document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent,
        );

        // Strategy B: <script id="SIGI_STATE"> (legacy)
        tryPush(document.getElementById('SIGI_STATE')?.textContent);

        // Strategy C: scan inline scripts for itemList / ItemModule blobs
        for (const s of document.querySelectorAll('script:not([src])')) {
            const text = s.textContent ?? '';
            if (!text.includes('itemList') && !text.includes('ItemModule')) continue;

            const m = text.match(/=\s*(\{[\s\S]{20,})/);
            if (m) {
                let raw = m[1], depth = 0, end = -1;
                for (let i = 0; i < raw.length; i++) {
                    if (raw[i] === '{') depth++;
                    else if (raw[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
                }
                if (end !== -1) tryPush(raw.slice(0, end + 1));
            }
        }

        return results;
    };
}

/**
 * Extracts normalised video items from any of the objects returned by the
 * page-state extractor running in Node context.
 *
 * @param {Object} obj - Any parsed JSON object found on the page.
 * @returns {Object[]} Array of normalised video items.
 */
function extractFromPageState(obj) {
    if (!obj || typeof obj !== 'object') return [];

    // Current TikTok format: { __DEFAULT_SCOPE__: { "webapp.user-post": { itemList: [...] } } }
    const scope = obj.__DEFAULT_SCOPE__ ?? obj;
    const userPost =
        scope?.['webapp.user-post'] ??
        scope?.['webapp.video-user'] ??
        null;
    if (userPost?.itemList?.length) {
        return userPost.itemList
            .map(normalizeVideoItem)
            .filter((v) => v.id && v.video.downloadUrl);
    }

    // Legacy SIGI_STATE format: { ItemModule: { "<id>": {...} } }
    if (obj.ItemModule && typeof obj.ItemModule === 'object') {
        return Object.values(obj.ItemModule)
            .map(normalizeVideoItem)
            .filter((v) => v.id && v.video.downloadUrl);
    }

    return [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrapes videos from a TikTok user profile page using Playwright.
 *
 * @param {string} profileUrl - Full TikTok profile URL
 *   (e.g. `https://www.tiktok.com/@username`).
 * @param {Object} [options]              - Scraping options.
 * @param {number} [options.limit=10]     - Maximum videos to return.
 * @param {string} [options.order='desc'] - `'desc'` newest-first, `'asc'` oldest-first.
 * @returns {Promise<Object[]>} Sorted and limited array of normalised video descriptors.
 */
export async function scrapeUserVideos(profileUrl, { limit = 10, order = 'desc' } = {}) {
    const username   = extractUsername(profileUrl);
    const videoMap   = new Map();
    const fetchTarget = Math.min(limit * 2, 100);

    const crawler = new PlaywrightCrawler({
        maxRequestsPerCrawl: 1,

        launchContext: {
            launchOptions: {
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    // Hide automation signals that TikTok checks.
                    '--disable-blink-features=AutomationControlled',
                    '--disable-features=IsolateOrigins,site-per-process',
                ],
            },
        },

        preNavigationHooks: [
            async ({ page }) => {
                // Mask navigator.webdriver and other automation tells.
                await page.addInitScript(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                    window.chrome = { runtime: {} };
                });

                // Intercept ALL JSON responses from tiktok.com before navigation starts.
                page.on('response', async (response) => {
                    const url = response.url();
                    if (!url.includes('tiktok.com')) return;

                    const ct = response.headers()['content-type'] ?? '';
                    if (!ct.includes('json')) return;

                    try {
                        const data  = await response.json();
                        const items = extractItemsFromApiResponse(data);
                        if (items.length) {
                            for (const v of items) videoMap.set(v.id, v);
                            log.debug(
                                `[${username}] Intercepted ${items.length} item(s) from `
                                + `${new URL(url).pathname} (total: ${videoMap.size})`,
                            );
                        }
                    } catch { /* non-JSON or consumed body — ignore */ }
                });
            },
        ],

        navigationTimeoutSecs:     60,
        requestHandlerTimeoutSecs: 300,

        async requestHandler({ page }) {
            log.info(`[${username}] Navigating to ${profileUrl}`);
            await page.goto(profileUrl, { waitUntil: 'networkidle', timeout: 60_000 });

            // Let React/Next.js fully hydrate the page.
            await page.waitForTimeout(4_000);

            // ── Extract initial batch from embedded page state ────────────────
            const rawObjects = await page.evaluate(buildPageStateExtractor());
            let initialCount = 0;

            for (const obj of rawObjects) {
                for (const v of extractFromPageState(obj)) {
                    if (!videoMap.has(v.id)) {
                        videoMap.set(v.id, v);
                        initialCount++;
                    }
                }
            }

            if (initialCount > 0) {
                log.info(`[${username}] Page state: ${initialCount} initial video(s).`);
            } else {
                log.warning(
                    `[${username}] No videos in page state — will rely on XHR interception.`,
                );
            }

            // ── Scroll to trigger lazy-loading ──────────────────────────────
            let stalledRounds = 0;

            while (videoMap.size < fetchTarget && stalledRounds < 5) {
                const before = videoMap.size;

                await page.evaluate(() =>
                    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }),
                );
                await page.waitForTimeout(3_000);

                if (videoMap.size === before) {
                    stalledRounds++;
                    log.debug(
                        `[${username}] No new videos after scroll `
                        + `(stalled ${stalledRounds}/5, total: ${videoMap.size})`,
                    );
                } else {
                    stalledRounds = 0;
                    log.debug(
                        `[${username}] +${videoMap.size - before} via scroll `
                        + `(total: ${videoMap.size})`,
                    );
                }
            }

            log.info(
                `[${username}] Scraping complete — ${videoMap.size} unique video(s) collected.`,
            );
        },
    });

    await crawler.run([{ url: profileUrl }]);

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
    return result;
}

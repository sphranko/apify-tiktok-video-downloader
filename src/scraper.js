/**
 * @file scraper.js
 * @description TikTok profile scraper using Playwright via Crawlee.
 *
 * Extraction strategy (tried in order):
 *  1. `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">` — current TikTok format
 *     (JSON embedded directly in the script element's text content).
 *  2. `<script id="SIGI_STATE">` — legacy TikTok SSR format.
 *  3. All inline `<script>` tags — brute-force search for any JSON blob that
 *     contains an `itemList` array (fallback for future format changes).
 *  4. XHR / fetch interception of `/api/post/item_list` and related endpoints
 *     (fires on scroll; captures all subsequent pages of videos).
 *
 * Note: TikTok frequently updates its front-end. If extraction stops working,
 * check the browser's network tab for the current API endpoint and the page
 * source for new JSON embed IDs.
 */

import { PlaywrightCrawler, log as crawleeLog } from 'crawlee';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the TikTok username from a profile URL.
 *
 * @param {string} url - A TikTok profile URL such as
 *   `https://www.tiktok.com/@username` or `https://www.tiktok.com/@username/`.
 * @returns {string} The username without the leading `@`.
 * @throws {Error} When the URL does not contain a username segment.
 */
function extractUsername(url) {
    const match = url.match(/@([^/?#]+)/);
    if (!match) throw new Error(`Cannot extract username from URL: ${url}`);
    return match[1];
}

/**
 * Normalises a raw TikTok video item (from any API / page-state version) into
 * a consistent shape that the rest of the actor uses.
 *
 * @param {Object} item - A raw video item object from TikTok's API or
 *   embedded page state.
 * @returns {Object} Normalised video descriptor.
 */
function normalizeVideoItem(item) {
    const author = item.author ?? {};
    const video  = item.video  ?? {};
    const stats  = item.stats  ?? item.statsV2 ?? {};

    // statsV2 values are strings; convert to numbers.
    const toNum = (v) => Number(v ?? 0);

    return {
        id:          String(item.id ?? ''),
        description: String(item.desc ?? ''),
        createTime:  Number(item.createTime ?? 0),
        author: {
            id:       String(item.authorId ?? author.id ?? ''),
            uniqueId: String(author.uniqueId ?? ''),
            nickname: String(author.nickname ?? ''),
        },
        video: {
            playUrl:     String(video.playAddr     ?? ''),
            downloadUrl: String(video.downloadAddr ?? video.playAddr ?? ''),
            cover:       String(video.cover        ?? ''),
            duration:    Number(video.duration     ?? 0),
            width:       Number(video.width        ?? 0),
            height:      Number(video.height       ?? 0),
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
 * Tries to extract an array of normalised video items from an arbitrary parsed
 * JSON object by traversing known path patterns.
 *
 * @param {Object} obj - Any parsed JSON object found on the page.
 * @returns {Object[]} Array of normalised video items (may be empty).
 */
function extractFromAnyObject(obj) {
    if (!obj || typeof obj !== 'object') return [];

    // ── Pattern 1: current format ────────────────────────────────────────────
    // { "__DEFAULT_SCOPE__": { "webapp.user-post": { itemList: [...] } } }
    const defaultScope = obj.__DEFAULT_SCOPE__ ?? obj;
    const userPost     =
        defaultScope?.['webapp.user-post'] ??
        defaultScope?.['webapp.video-user'] ??
        null;

    if (userPost?.itemList?.length) {
        return userPost.itemList.map(normalizeVideoItem);
    }

    // ── Pattern 2: legacy SIGI_STATE format ─────────────────────────────────
    // { ItemModule: { "<videoId>": { … } } }
    if (obj.ItemModule && typeof obj.ItemModule === 'object') {
        const items = Object.values(obj.ItemModule);
        if (items.length) return items.map(normalizeVideoItem);
    }

    // ── Pattern 3: plain itemList at root ───────────────────────────────────
    if (Array.isArray(obj.itemList) && obj.itemList.length) {
        return obj.itemList.map(normalizeVideoItem);
    }

    return [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrapes videos from a TikTok user profile page.
 *
 * @param {string} profileUrl - Full TikTok profile URL
 *   (e.g. `https://www.tiktok.com/@username`).
 * @param {Object} [options]              - Scraping options.
 * @param {number} [options.limit=10]     - Maximum number of videos to return.
 * @param {string} [options.order='desc'] - `'desc'` for newest-first,
 *   `'asc'` for oldest-first.
 * @returns {Promise<Object[]>} Sorted and limited array of normalised video
 *   items, each enriched with a canonical `url` field.
 */
export async function scrapeUserVideos(profileUrl, { limit = 10, order = 'desc' } = {}) {
    const username = extractUsername(profileUrl);

    /** @type {Map<string, Object>} Deduplication map: videoId → normalised item */
    const videoMap = new Map();

    // Collect slightly more than requested so that after dedup + sort we still
    // have `limit` items even when a few arrive out-of-order.
    const fetchTarget = Math.min(limit * 2, 100);

    const crawler = new PlaywrightCrawler({
        maxRequestsPerCrawl: 1,

        launchContext: {
            launchOptions: {
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    // Helps avoid bot-detection in headless Chrome.
                    '--disable-blink-features=AutomationControlled',
                ],
            },
        },

        navigationTimeoutSecs:    60,
        requestHandlerTimeoutSecs: 300,

        async requestHandler({ page }) {
            // ------------------------------------------------------------------
            // 1. Intercept XHR / fetch responses for video-list API endpoints.
            // ------------------------------------------------------------------
            page.on('response', async (response) => {
                const url = response.url();
                const isVideoApi =
                    url.includes('/api/post/item_list')  ||
                    url.includes('/api/user/post')        ||
                    url.includes('/api/post/feed');

                if (!isVideoApi) return;

                try {
                    const data = await response.json();
                    const items = data.itemList ?? data.items ?? [];
                    if (Array.isArray(items) && items.length) {
                        for (const item of items) {
                            const v = normalizeVideoItem(item);
                            if (v.id) videoMap.set(v.id, v);
                        }
                        crawleeLog.debug(
                            `[${username}] API intercept (${new URL(url).pathname}): `
                            + `+${items.length} videos (total: ${videoMap.size})`,
                        );
                    }
                } catch {
                    // Non-JSON body or already-consumed; silently ignore.
                }
            });

            // ------------------------------------------------------------------
            // 2. Navigate to the profile page.
            // ------------------------------------------------------------------
            crawleeLog.info(`[${username}] Navigating to ${profileUrl}`);
            await page.goto(profileUrl, {
                waitUntil: 'networkidle',
                timeout:   60_000,
            });

            // Give React/Next.js time to fully hydrate.
            await page.waitForTimeout(3_000);

            // ------------------------------------------------------------------
            // 3. Extract the initial video batch from embedded page state.
            // ------------------------------------------------------------------
            const extracted = await page.evaluate(() => {
                const results = [];

                /**
                 * Tries to parse `text` as JSON and pushes the result to
                 * `results` if it looks like it could contain video data.
                 * @param {string} text
                 */
                function tryParse(text) {
                    if (!text || text.length < 50) return;
                    try {
                        const obj = JSON.parse(text.trim());
                        results.push(obj);
                    } catch { /* not valid JSON */ }
                }

                // Strategy A: <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">
                tryParse(
                    document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent,
                );

                // Strategy B: <script id="SIGI_STATE">
                tryParse(
                    document.getElementById('SIGI_STATE')?.textContent,
                );

                // Strategy C: scan all inline scripts for JSON blobs that
                // mention "itemList" — catches any future rename.
                for (const s of document.querySelectorAll('script:not([src])')) {
                    const text = s.textContent ?? '';
                    if (!text.includes('itemList') && !text.includes('ItemModule')) continue;

                    // The blob might be assigned to a window variable:
                    // window["X"] = {...}; or window.X = {...};
                    // Try to extract the raw JSON portion.
                    const assignMatch = text.match(/=\s*(\{[\s\S]{20,})/);
                    if (assignMatch) {
                        // Strip trailing code after the JSON object.
                        let raw = assignMatch[1];
                        // Walk backwards from the end to find the matching `}`.
                        let depth = 0, end = -1;
                        for (let i = 0; i < raw.length; i++) {
                            if (raw[i] === '{') depth++;
                            else if (raw[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
                        }
                        if (end !== -1) tryParse(raw.slice(0, end + 1));
                    } else {
                        // The whole script content might be raw JSON.
                        tryParse(text);
                    }
                }

                return results;
            });

            let initialFound = 0;
            for (const obj of extracted) {
                const items = (() => {
                    // extractFromAnyObject runs in Node context (not the browser).
                    // We just return the raw object and process it here.
                    return obj;
                })();
                // Process will happen outside page.evaluate in Node context.
                void items;
            }

            // Process all extracted objects in Node context.
            for (const obj of extracted) {
                const items = extractFromAnyObject(obj);
                for (const v of items) {
                    if (v.id && !videoMap.has(v.id)) {
                        videoMap.set(v.id, v);
                        initialFound++;
                    }
                }
            }

            if (initialFound > 0) {
                crawleeLog.info(
                    `[${username}] Embedded page state: ${initialFound} initial videos.`,
                );
            } else {
                crawleeLog.warning(
                    `[${username}] No videos found in embedded page state. `
                    + 'Will rely on XHR interception via scrolling.',
                );
            }

            // ------------------------------------------------------------------
            // 4. Scroll to trigger lazy-loading of additional videos.
            // ------------------------------------------------------------------
            let stalledRounds = 0;

            while (videoMap.size < fetchTarget && stalledRounds < 5) {
                const before = videoMap.size;

                await page.evaluate(() =>
                    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }),
                );
                await page.waitForTimeout(3_000);

                if (videoMap.size === before) {
                    stalledRounds++;
                    crawleeLog.debug(
                        `[${username}] No new videos after scroll `
                        + `(stalled ${stalledRounds}/5, total: ${videoMap.size})`,
                    );
                } else {
                    stalledRounds = 0;
                    crawleeLog.debug(
                        `[${username}] +${videoMap.size - before} via scroll `
                        + `(total: ${videoMap.size})`,
                    );
                }
            }

            crawleeLog.info(
                `[${username}] Scraping complete. Collected ${videoMap.size} unique videos.`,
            );
        },
    });

    await crawler.run([{ url: profileUrl }]);

    // Sort by creation timestamp and cap at the requested limit.
    const videos = Array.from(videoMap.values());
    videos.sort((a, b) =>
        order === 'asc'
            ? a.createTime - b.createTime
            : b.createTime - a.createTime,
    );

    const result = videos.slice(0, limit);

    // Attach the canonical TikTok watch URL to each item.
    for (const v of result) {
        v.url = `https://www.tiktok.com/@${v.author.uniqueId}/video/${v.id}`;
    }

    return result;
}

/**
 * @file scraper.js
 * @description TikTok profile scraper using Playwright via Crawlee.
 *
 * Strategy:
 *  1. Navigate to the TikTok profile page.
 *  2. Intercept `/api/post/item_list/` XHR calls (fired on scroll) to capture
 *     video metadata for all subsequent page loads.
 *  3. Extract the initial batch of videos embedded in the page HTML
 *     (TikTok embeds them as JSON inside `<script id="SIGI_STATE">` or as the
 *     `__UNIVERSAL_DATA_STORE__` variable — both formats are handled).
 *  4. Scroll the page until enough videos have been collected or there are no
 *     more videos to load.
 *  5. Sort by creation timestamp and apply the caller-supplied limit.
 *
 * Note: TikTok frequently updates its front-end structure. If extraction stops
 * working, the selectors or JSON paths below may need to be updated.
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
 * Normalises a raw TikTok video item (from any API version) into a consistent
 * shape that the rest of the actor works with.
 *
 * @param {Object} item - A raw video item object from TikTok's API or page state.
 * @returns {Object} Normalised video descriptor.
 */
function normalizeVideoItem(item) {
    const author = item.author ?? {};
    const video  = item.video  ?? {};
    const stats  = item.stats  ?? {};

    return {
        id:          String(item.id ?? ''),
        description: String(item.desc ?? ''),
        createTime:  Number(item.createTime ?? 0),
        author: {
            id:       String(item.authorId ?? author.id ?? ''),
            uniqueId: String(author.uniqueId ?? item.authorId ?? ''),
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
            plays:    Number(stats.playCount    ?? 0),
            likes:    Number(stats.diggCount    ?? 0),
            comments: Number(stats.commentCount ?? 0),
            shares:   Number(stats.shareCount   ?? 0),
        },
    };
}

/**
 * Parses video items from TikTok's `SIGI_STATE` embedded JSON object.
 *
 * @param {Object} sigiState - The parsed `SIGI_STATE` object.
 * @returns {Object[]} Array of normalised video items.
 */
function parseFromSigiState(sigiState) {
    const itemModule = sigiState?.ItemModule ?? {};
    return Object.values(itemModule).map(normalizeVideoItem);
}

/**
 * Parses video items from TikTok's newer `__UNIVERSAL_DATA_STORE__` format.
 *
 * @param {Object} universalStore - The parsed universal data store object.
 * @returns {Object[]} Array of normalised video items.
 */
function parseFromUniversalStore(universalStore) {
    // Dig into the nested structure used in the newer TikTok front-end.
    const webapp = universalStore?.['webapp.user-detail']?.userInfo ?? {};
    const items  =
        universalStore?.['webapp.video-user']?.itemList ??
        universalStore?.['webapp.user-post']?.itemList  ??
        [];
    return Array.isArray(items) ? items.map(normalizeVideoItem) : [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrapes videos from a TikTok user profile page.
 *
 * @param {string} profileUrl - Full TikTok profile URL
 *   (e.g. `https://www.tiktok.com/@username`).
 * @param {Object}  [options]          - Scraping options.
 * @param {number}  [options.limit=10] - Maximum number of videos to return.
 * @param {string}  [options.order='desc'] - `'desc'` for newest-first,
 *   `'asc'` for oldest-first.
 * @returns {Promise<Object[]>} Sorted and limited array of normalised video
 *   items.
 */
export async function scrapeUserVideos(profileUrl, { limit = 10, order = 'desc' } = {}) {
    const username = extractUsername(profileUrl);
    /** @type {Map<string, Object>} Deduplication map: videoId → normalised item */
    const videoMap = new Map();

    // We try to collect slightly more than requested so that after sorting we
    // still have `limit` items even if a few arrive out-of-order across calls.
    const fetchTarget = Math.min(limit * 2, 100);

    const crawler = new PlaywrightCrawler({
        maxRequestsPerCrawl: 1,

        launchContext: {
            launchOptions: {
                // Required in most Linux / Docker environments.
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
            },
        },

        // Give the page enough time to load and the network to settle.
        navigationTimeoutSecs: 60,
        requestHandlerTimeoutSecs: 300,

        async requestHandler({ page }) {
            // ------------------------------------------------------------------
            // 1. Intercept subsequent XHR video-list API responses.
            // ------------------------------------------------------------------
            page.on('response', async (response) => {
                if (!response.url().includes('/api/post/item_list/')) return;
                try {
                    const data = await response.json();
                    if (Array.isArray(data.itemList)) {
                        for (const item of data.itemList) {
                            const v = normalizeVideoItem(item);
                            if (v.id) videoMap.set(v.id, v);
                        }
                        crawleeLog.debug(
                            `[${username}] API intercept: +${data.itemList.length} videos `
                            + `(total: ${videoMap.size})`,
                        );
                    }
                } catch {
                    // Silently ignore non-JSON or already-consumed response bodies.
                }
            });

            // ------------------------------------------------------------------
            // 2. Navigate to the profile page.
            // ------------------------------------------------------------------
            crawleeLog.info(`[${username}] Navigating to ${profileUrl}`);
            await page.goto(profileUrl, {
                waitUntil: 'domcontentloaded',
                timeout:   60_000,
            });

            // Wait briefly for JS hydration before reading embedded state.
            await page.waitForTimeout(2_000);

            // ------------------------------------------------------------------
            // 3. Extract initial video batch from embedded page state.
            // ------------------------------------------------------------------
            const pageState = await page.evaluate(() => {
                // Strategy A: <script id="SIGI_STATE">…</script>
                try {
                    const el = document.getElementById('SIGI_STATE');
                    if (el?.textContent?.trim()) {
                        return { type: 'sigi', data: JSON.parse(el.textContent) };
                    }
                } catch { /* fall through */ }

                // Strategy B: inline script containing __UNIVERSAL_DATA_STORE__
                try {
                    for (const s of document.querySelectorAll('script')) {
                        const text = s.textContent ?? '';
                        const idx  = text.indexOf('__UNIVERSAL_DATA_STORE__');
                        if (idx === -1) continue;
                        // The pattern is: window["__UNIVERSAL_DATA_STORE__"] = {...};
                        const match = text.slice(idx).match(/=\s*(\{[\s\S]+?\});\s*(?:window|$)/);
                        if (match) {
                            return { type: 'universal', data: JSON.parse(match[1]) };
                        }
                    }
                } catch { /* fall through */ }

                return null;
            });

            if (pageState) {
                const initial =
                    pageState.type === 'sigi'
                        ? parseFromSigiState(pageState.data)
                        : parseFromUniversalStore(pageState.data);

                for (const v of initial) {
                    if (v.id) videoMap.set(v.id, v);
                }
                crawleeLog.info(
                    `[${username}] Page state (${pageState.type}): `
                    + `${initial.length} initial videos`,
                );
            } else {
                crawleeLog.warning(
                    `[${username}] No embedded page state found; `
                    + 'relying on XHR interception.',
                );
            }

            // ------------------------------------------------------------------
            // 4. Scroll to load more videos when needed.
            // ------------------------------------------------------------------
            let stalledRounds = 0;

            while (videoMap.size < fetchTarget && stalledRounds < 3) {
                const before = videoMap.size;

                await page.evaluate(() =>
                    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }),
                );
                // Allow the network request to complete and the DOM to update.
                await page.waitForTimeout(2_500);

                if (videoMap.size === before) {
                    stalledRounds++;
                    crawleeLog.debug(
                        `[${username}] No new videos after scroll `
                        + `(stalled ${stalledRounds}/3, total: ${videoMap.size})`,
                    );
                } else {
                    stalledRounds = 0;
                }
            }

            crawleeLog.info(
                `[${username}] Scraping complete. Collected ${videoMap.size} unique videos.`,
            );
        },
    });

    await crawler.run([{ url: profileUrl }]);

    // Sort and limit.
    const videos = Array.from(videoMap.values());
    videos.sort((a, b) =>
        order === 'asc'
            ? a.createTime - b.createTime
            : b.createTime - a.createTime,
    );

    const result = videos.slice(0, limit);
    // Attach the canonical TikTok URL to each item once we have the final list.
    for (const v of result) {
        v.url = `https://www.tiktok.com/@${v.author.uniqueId}/video/${v.id}`;
    }

    return result;
}

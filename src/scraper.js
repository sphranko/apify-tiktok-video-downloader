/**
 * @file scraper.js
 * @description TikTok profile scraper using Playwright via Crawlee.
 *
 * Core technique:
 *  1. Navigate to the TikTok profile page (domcontentloaded — faster, less RAM).
 *  2. Intercept every request matching *tiktok.com/api/** with `page.route()`.
 *     Unlike `page.on('response')`, routing gives us exclusive ownership of the
 *     response body so `response.text()` never throws "body already consumed".
 *  3. Parse any intercepted JSON that contains a video list (itemList, aweme_list…).
 *  4. Scroll the page to trigger TikTok's own pagination API calls.
 *  5. After collection, capture session cookies for the caller to use when
 *     downloading CDN video files.
 */

import { PlaywrightCrawler, log } from 'crawlee';

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
 * Handles both the web format (playAddr, stats.*Count) and the mobile/aweme
 * format (play_addr.url_list, statistics.*_count).
 *
 * @param {Object} item - Raw video item.
 * @returns {Object|null} Normalised video descriptor, or null if unusable.
 */
function normalizeVideoItem(item) {
    const isAweme = Boolean(item.aweme_id);
    const author  = item.author     ?? {};
    const video   = item.video      ?? {};
    const stats   = item.stats      ?? item.statistics ?? {};

    const id = String(isAweme ? (item.aweme_id ?? '') : (item.id ?? ''));
    if (!id) return null;

    // createTime from TikTok is Unix seconds; convert to ms for JS Date compatibility.
    const createTimeSec = Number(isAweme ? (item.create_time ?? 0) : (item.createTime ?? 0));

    const playUrl =
        video.playAddr ??
        video.play_addr?.url_list?.[0] ??
        video.downloadAddr ??
        video.download_addr?.url_list?.[0] ??
        '';

    // isPinned: exclude from results but keep in normaliser so callers can filter.
    const isPinned = Boolean(isAweme ? (item.is_top ?? 0) : (item.isTop ?? 0));

    return {
        id,
        isPinned,
        description: String(item.desc ?? ''),
        createTime:  createTimeSec,
        createDate:  createTimeSec ? new Date(createTimeSec * 1000).toISOString() : null,
        author: {
            id:       String(author.uid      ?? author.id    ?? item.authorId ?? ''),
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
            plays:    Number(stats.playCount    ?? stats.play_count    ?? 0),
            likes:    Number(stats.diggCount    ?? stats.digg_count    ?? 0),
            comments: Number(stats.commentCount ?? stats.comment_count ?? 0),
            shares:   Number(stats.shareCount   ?? stats.share_count   ?? 0),
        },
    };
}

/**
 * Tries to extract a list of video items from a parsed API response object.
 *
 * @param {Object} data - Parsed JSON from any TikTok endpoint.
 * @returns {Object[]} Array of normalised video items (may be empty).
 */
function extractFromApiPayload(data) {
    const list =
        data?.itemList       ??
        data?.aweme_list     ??
        data?.items          ??
        data?.data?.itemList ??
        data?.data?.aweme_list ??
        null;

    if (!Array.isArray(list) || list.length === 0) return [];

    return list.map(normalizeVideoItem).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrapes videos from a TikTok user profile page using Playwright.
 *
 * @param {string} profileUrl - Full TikTok profile URL.
 * @param {Object} [options]              - Scraping options.
 * @param {number} [options.limit=10]     - Maximum videos to return.
 * @param {string} [options.order='desc'] - `'desc'` newest-first, `'asc'` oldest-first.
 * @returns {Promise<{ videos: Object[], cookies: string }>}
 *   `videos`  — sorted and limited array of normalised video descriptors.
 *   `cookies` — raw Cookie header string from the browser session, required
 *               to download watermark-free video files from TikTok's CDN.
 */
export async function scrapeUserVideos(profileUrl, { limit = 10, order = 'desc' } = {}) {
    const username    = extractUsername(profileUrl);
    const videoMap    = new Map(); // videoId → normalised item
    let   sessionCookies = '';

    const crawler = new PlaywrightCrawler({
        maxRequestsPerCrawl: 1,

        launchContext: {
            launchOptions: {
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    // Prevents Chrome from crashing when /dev/shm is small (Docker).
                    '--disable-dev-shm-usage',
                    // Hide Playwright's automation fingerprint.
                    '--disable-blink-features=AutomationControlled',
                    // Memory savings.
                    '--disable-extensions',
                    '--disable-background-networking',
                    '--disable-default-apps',
                    '--disable-sync',
                    '--mute-audio',
                    '--disable-gpu',
                ],
            },
        },

        preNavigationHooks: [
            async ({ page }) => {
                // ── Stealth: hide automation signals ─────────────────────────
                await page.addInitScript(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                    window.chrome = { runtime: {} };
                });

                // ── Route interception — profile video list endpoints only ────
                // Targeting item_list and user/post avoids catching suggested
                // content, ads, or other accounts' videos that TikTok also loads
                // on a profile page.
                // page.route() gives exclusive response-body access so
                // response.text() never throws "body already consumed".
                await page.route(/tiktok\.com\/api\/(post\/item_list|user\/post)/, async (route) => {
                    let response;
                    try {
                        response = await route.fetch();
                    } catch {
                        await route.continue();
                        return;
                    }

                    // Read body as text first so we can handle non-JSON gracefully.
                    let text = '';
                    try { text = await response.text(); } catch { /* ignore */ }

                    if (text.trimStart().startsWith('{')) {
                        try {
                            const data  = JSON.parse(text);
                            const items = extractFromApiPayload(data);

                            // Keep only videos that belong to the target profile.
                            const own = items.filter(
                                (v) => !v.author.uniqueId
                                    || v.author.uniqueId.toLowerCase() === username.toLowerCase(),
                            );

                            if (own.length) {
                                for (const v of own) videoMap.set(v.id, v);
                                log.debug(
                                    `[${username}] Intercepted ${own.length} item(s) from `
                                    + `${new URL(route.request().url()).pathname} `
                                    + `(total: ${videoMap.size})`,
                                );
                            }
                        } catch { /* malformed JSON — ignore */ }
                    }

                    // Forward the original response body to the page's own JS.
                    await route.fulfill({
                        status:  response.status(),
                        headers: response.headers(),
                        body:    text,
                    });
                });
            },
        ],

        navigationTimeoutSecs:     60,
        requestHandlerTimeoutSecs: 300,

        async requestHandler({ page }) {
            log.info(`[${username}] Navigating to ${profileUrl}`);

            // domcontentloaded is faster and uses less RAM than networkidle.
            // We wait for the API responses via the route interceptor instead.
            await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

            // Give the page time to hydrate and fire initial API calls.
            await page.waitForTimeout(5_000);

            log.info(`[${username}] Initial load done — ${videoMap.size} video(s) so far.`);

            // ── Scroll to trigger pagination API calls ────────────────────────
            const fetchTarget  = Math.min(limit * 2, 100);
            let   stalledRounds = 0;

            while (videoMap.size < fetchTarget && stalledRounds < 5) {
                const before = videoMap.size;

                await page.evaluate(() =>
                    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }),
                );
                // Wait for TikTok's XHR to fire and our route handler to process it.
                await page.waitForTimeout(3_000);

                if (videoMap.size > before) {
                    stalledRounds = 0;
                    log.debug(
                        `[${username}] +${videoMap.size - before} after scroll `
                        + `(total: ${videoMap.size})`,
                    );
                } else {
                    stalledRounds++;
                    log.debug(
                        `[${username}] No new videos (stalled ${stalledRounds}/5, `
                        + `total: ${videoMap.size})`,
                    );
                }
            }

            log.info(`[${username}] Collection done — ${videoMap.size} unique video(s).`);

            // ── Capture session cookies for CDN downloads ─────────────────────
            // Getting all cookies (no URL filter) ensures we include subdomains
            // used by TikTok's CDN (e.g. v19-webapp.tiktok.com).
            const allCookies = await page.context().cookies();
            sessionCookies   = allCookies.map((c) => `${c.name}=${c.value}`).join('; ');
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

    return { videos: result, cookies: sessionCookies };
}

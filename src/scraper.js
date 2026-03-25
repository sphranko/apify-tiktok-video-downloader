/**
 * @file scraper.js
 * @description TikTok profile scraper using Playwright via Crawlee.
 *
 * Core technique (same approach used by clockworks/tiktok-scraper):
 *  1. Navigate to the TikTok profile page so the browser obtains valid session
 *     cookies (ms_token, tt_csrf_token, etc.) and TikTok loads its signing JS.
 *  2. Extract the user's `secUid` from the embedded page state.
 *  3. Call TikTok's internal `/api/post/item_list/` endpoint via
 *     `page.evaluate(() => fetch(...))` — the request runs inside the browser
 *     context so cookies and CSRF tokens are sent automatically, and TikTok's
 *     own `byted_acrawler.frontierSign()` can sign the URL if available.
 *  4. Paginate until the requested number of videos is reached.
 *  5. Capture the session cookies before closing the browser so the caller can
 *     use them to download the CDN video files.
 */

import { PlaywrightCrawler, log } from 'crawlee';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** TikTok internal video-list API — same endpoint intercepted by clockworks. */
const ITEM_LIST_URL = 'https://www.tiktok.com/api/post/item_list/';

/** Videos fetched per API page (TikTok's max for this endpoint). */
const PAGE_SIZE = 30;

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
 * Normalises a raw TikTok API video item (web format from /api/post/item_list/)
 * into the internal shape used by main.js and downloader.js.
 *
 * @param {Object} item - Raw video item.
 * @returns {Object} Normalised video descriptor.
 */
function normalizeVideoItem(item) {
    const author = item.author   ?? {};
    const video  = item.video    ?? {};
    const stats  = item.stats    ?? {};

    // playAddr is the watermark-free stream; downloadAddr may have watermark.
    // We prefer playAddr for clean output.
    const downloadUrl = String(video.playAddr ?? video.downloadAddr ?? '');

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
            downloadUrl,
            cover:    String(video.cover    ?? video.originCover ?? ''),
            duration: Number(video.duration ?? 0),
            width:    Number(video.width    ?? 0),
            height:   Number(video.height   ?? 0),
        },
        stats: {
            plays:    Number(stats.playCount    ?? 0),
            likes:    Number(stats.diggCount    ?? 0),
            comments: Number(stats.commentCount ?? 0),
            shares:   Number(stats.shareCount   ?? 0),
        },
    };
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
 * @param {number} [options.limit=10]     - Maximum videos to return.
 * @param {string} [options.order='desc'] - `'desc'` newest-first, `'asc'` oldest-first.
 * @returns {Promise<{ videos: Object[], cookies: string }>}
 *   `videos` — sorted and limited array of normalised video descriptors.
 *   `cookies` — raw Cookie header string captured from the browser session,
 *               to be forwarded when downloading CDN video files.
 */
export async function scrapeUserVideos(profileUrl, { limit = 10, order = 'desc' } = {}) {
    const username    = extractUsername(profileUrl);
    const videoMap    = new Map();
    let   sessionCookies = '';

    const crawler = new PlaywrightCrawler({
        maxRequestsPerCrawl: 1,

        launchContext: {
            launchOptions: {
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    // Critical in Docker: avoids /dev/shm exhaustion that causes Chrome to crash.
                    '--disable-dev-shm-usage',
                    // Hide automation signals that TikTok checks.
                    '--disable-blink-features=AutomationControlled',
                    // Reduce memory footprint.
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
                // Mask navigator.webdriver before any page script runs.
                await page.addInitScript(() => {
                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                    window.chrome = { runtime: {} };
                });
            },
        ],

        navigationTimeoutSecs:     60,
        requestHandlerTimeoutSecs: 300,

        async requestHandler({ page }) {
            log.info(`[${username}] Navigating to ${profileUrl}`);
            await page.goto(profileUrl, { waitUntil: 'networkidle', timeout: 60_000 });

            // Allow React hydration to complete.
            await page.waitForTimeout(3_000);

            // ── Step 1: extract secUid from embedded page state ───────────────
            const secUid = await page.evaluate(() => {
                try {
                    const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
                    if (el) {
                        const scope = JSON.parse(el.textContent)?.__DEFAULT_SCOPE__;
                        const user  = scope?.['webapp.user-detail']?.userInfo?.user;
                        if (user?.secUid) return user.secUid;
                    }
                } catch { /* fall through */ }

                // Legacy SIGI_STATE fallback
                try {
                    const el = document.getElementById('SIGI_STATE');
                    if (el) {
                        const data = JSON.parse(el.textContent);
                        const users = Object.values(data?.UserModule?.users ?? {});
                        if (users.length) return users[0].secUid;
                    }
                } catch { /* fall through */ }

                return null;
            });

            if (!secUid) {
                log.warning(
                    `[${username}] Could not extract secUid from page state. `
                    + 'TikTok may have served a bot-detection page.',
                );
                return;
            }

            log.info(`[${username}] secUid extracted. Fetching video list via API.`);

            // ── Step 2: fetch video pages via TikTok's API from browser context ─
            // Running the fetch inside page.evaluate means the browser sends its
            // own cookies automatically — this is the key that makes the request
            // look legitimate to TikTok's servers.
            let cursor  = 0;
            let hasMore = true;

            while (videoMap.size < limit * 2 && hasMore) {
                const params = {
                    aid:               '1988',
                    app_name:          'tiktok_web',
                    device_platform:   'web_pc',
                    browser_language:  'en-US',
                    browser_platform:  'Win32',
                    browser_name:      'Mozilla',
                    browser_version:   '5.0 (Windows)',
                    os:                'windows',
                    secUid,
                    count:             String(PAGE_SIZE),
                    cursor:            String(cursor),
                    type:              '1',
                    sourceType:        '8',
                    appId:             '1233',
                    region:            'US',
                    language:          'en',
                };

                // eslint-disable-next-line no-await-in-loop
                const response = await page.evaluate(async ({ baseUrl, params }) => {
                    const qs  = new URLSearchParams(params).toString();
                    let   url = `${baseUrl}?${qs}`;

                    // Sign the URL with TikTok's own function if loaded.
                    try {
                        if (typeof window.byted_acrawler?.frontierSign === 'function') {
                            url = window.byted_acrawler.frontierSign(url);
                        }
                    } catch { /* signing not available, proceed unsigned */ }

                    try {
                        const resp = await fetch(url, {
                            credentials: 'include',
                            headers: {
                                Accept:          'application/json, text/plain, */*',
                                'Accept-Language': 'en-US,en;q=0.9',
                                Referer:         'https://www.tiktok.com/',
                            },
                        });
                        return resp.json();
                    } catch (err) {
                        return { __fetchError: err.message };
                    }
                }, { baseUrl: ITEM_LIST_URL, params });

                if (response?.__fetchError) {
                    log.error(`[${username}] API fetch error: ${response.__fetchError}`);
                    break;
                }

                const items = response?.itemList ?? [];
                for (const item of items) {
                    const v = normalizeVideoItem(item);
                    if (v.id && v.video.downloadUrl) videoMap.set(v.id, v);
                }

                log.info(
                    `[${username}] API page fetched — +${items.length} item(s) `
                    + `(total: ${videoMap.size}, cursor: ${cursor})`,
                );

                hasMore = Boolean(response?.hasMore);
                cursor  = Number(response?.cursor ?? 0);

                if (!items.length) break;
            }

            log.info(`[${username}] Collection done — ${videoMap.size} unique video(s).`);

            // ── Step 3: capture session cookies for CDN downloads ─────────────
            const cookies = await page.context().cookies('https://www.tiktok.com');
            sessionCookies = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
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

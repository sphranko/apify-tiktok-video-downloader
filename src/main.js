/**
 * @file main.js
 * @description Entry point for the TikTok Video Scraper & Downloader Apify Actor.
 *
 * Flow:
 *  1. For each profile URL, open a Playwright browser session to scrape video
 *     metadata via TikTok's internal API (scraper.js). The session cookies are
 *     captured before the browser closes.
 *  2. Optionally download each MP4 using the captured cookies (downloader.js)
 *     and save the binary to the Apify Key-Value Store.
 *  3. Push every video record to the Apify Dataset.
 *
 * Input schema (see .actor/input_schema.json):
 *  - profileUrls    {string[]} TikTok profile URLs to scrape.
 *  - limit          {number}   Max videos per profile. Default: 10.
 *  - order          {string}   'desc' (newest first) | 'asc' (oldest first).
 *  - downloadVideos {boolean}  Whether to download MP4 files. Default: true.
 */

import { Actor } from 'apify';
import { log }   from 'crawlee';
import { scrapeUserVideos } from './scraper.js';
import { downloadVideo }    from './downloader.js';

/**
 * Public Apify API base URL for constructing KV-store record links.
 * We intentionally ignore APIFY_API_BASE_URL here because on Apify's
 * infrastructure that variable resolves to an internal IP (e.g. 10.0.x.x)
 * which is unreachable from outside the cluster.
 */
const APIFY_API_BASE = 'https://api.apify.com';

await Actor.main(async () => {
    // ------------------------------------------------------------------
    // 1. Read and validate input.
    // ------------------------------------------------------------------
    const input = await Actor.getInput();

    if (!input) {
        throw new Error(
            'Actor input is missing. '
            + 'Please provide at least one TikTok profile URL via the "profileUrls" field.',
        );
    }

    const {
        profileUrls    = [],
        limit          = 10,
        order          = 'desc',
        downloadVideos = true,
    } = input;

    if (!Array.isArray(profileUrls) || profileUrls.length === 0) {
        throw new Error('"profileUrls" must be a non-empty array of TikTok profile URLs.');
    }

    if (!['asc', 'desc'].includes(order)) {
        throw new Error('"order" must be either "asc" or "desc".');
    }

    log.info(
        `Starting actor — profiles: ${profileUrls.length}, `
        + `limit: ${limit}, order: ${order}, downloadVideos: ${downloadVideos}`,
    );

    // ------------------------------------------------------------------
    // 2. Open Apify storages.
    // ------------------------------------------------------------------
    const dataset = await Actor.openDataset();
    const store   = await Actor.openKeyValueStore();

    // ------------------------------------------------------------------
    // 3. Process each profile.
    // ------------------------------------------------------------------
    for (const profileUrl of profileUrls) {
        log.info(`\n=== Processing profile: ${profileUrl} ===`);

        // 3a. Scrape the video list; also capture browser session cookies.
        let videos;
        let cookies;

        try {
            ({ videos, cookies } = await scrapeUserVideos(profileUrl, { limit, order }));
        } catch (err) {
            log.error(`Failed to scrape "${profileUrl}": ${err.message}`);
            continue;
        }

        log.info(`Found ${videos.length} video(s) for "${profileUrl}".`);

        // 3b. Optionally download each video and push its record to the dataset.
        for (const video of videos) {
            const record = { ...video };

            if (downloadVideos && video.video.downloadUrl) {
                const storageKey = `video-${video.id}.mp4`;

                try {
                    // Forward the captured browser cookies so TikTok's CDN
                    // accepts the download request.
                    const buffer = await downloadVideo(
                        video.video.downloadUrl,
                        video.id,
                        cookies,
                    );
                    await store.setValue(storageKey, buffer, { contentType: 'video/mp4' });

                    record.storageKey = storageKey;
                    record.storageUrl =
                        `${APIFY_API_BASE}/v2/key-value-stores/${store.id}/records/${storageKey}`;

                    log.info(`[${video.id}] Saved to KV store — key: "${storageKey}"`);
                } catch (err) {
                    log.error(
                        `[${video.id}] Download failed: ${err.message}. `
                        + 'Record will be saved without a storageUrl.',
                    );
                }
            }

            await dataset.pushData(record);
        }
    }

    log.info('Actor finished successfully.');
});

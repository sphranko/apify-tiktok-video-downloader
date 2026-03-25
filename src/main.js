/**
 * @file main.js
 * @description Entry point for the TikTok Video Scraper & Downloader Apify Actor.
 *
 * Flow:
 *  1. For each profile URL, fetch video metadata via tikwm.com (scraper.js).
 *     The response already includes watermark-free CDN download URLs.
 *  2. Optionally download each MP4 binary and save it to the Apify
 *     Key-Value Store (downloader.js).
 *  3. Push every video record to the Apify Dataset, including a `storageUrl`
 *     when the file was successfully saved.
 *
 * Input schema (see .actor/input_schema.json):
 *  - profileUrls    {string[]} TikTok profile URLs to scrape.
 *  - limit          {number}   Max videos per profile. Default: 10.
 *  - order          {string}   'desc' (newest first) | 'asc' (oldest first).
 *  - downloadVideos {boolean}  Whether to download MP4 files. Default: true.
 *
 * Output (Apify Dataset):
 *  Each record contains video metadata plus an optional `storageUrl` field
 *  pointing to the downloaded MP4 in the Apify Key-Value Store.
 */

import { Actor } from 'apify';
import { scrapeUserVideos } from './scraper.js';
import { downloadVideo }    from './downloader.js';

/** Base URL for the Apify API, used to build public KV-store record URLs. */
const APIFY_API_BASE = process.env.APIFY_API_BASE_URL ?? 'https://api.apify.com';

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

    Actor.log.info(
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
        Actor.log.info(`\n=== Processing profile: ${profileUrl} ===`);

        // 3a. Fetch video list via tikwm.com.
        let videos;
        try {
            videos = await scrapeUserVideos(profileUrl, { limit, order });
        } catch (err) {
            Actor.log.error(`Failed to scrape "${profileUrl}": ${err.message}`);
            continue;
        }

        Actor.log.info(`Found ${videos.length} video(s) for "${profileUrl}".`);

        // 3b. Optionally download each video and push the record to the dataset.
        for (const video of videos) {
            /** @type {Object} The final dataset record for this video. */
            const record = { ...video };

            if (downloadVideos) {
                const storageKey = `video-${video.id}.mp4`;

                try {
                    const buffer = await downloadVideo(video.video.downloadUrl, video.id);
                    await store.setValue(storageKey, buffer, { contentType: 'video/mp4' });

                    record.storageKey = storageKey;
                    record.storageUrl =
                        `${APIFY_API_BASE}/v2/key-value-stores/${store.id}/records/${storageKey}`;

                    Actor.log.info(`[${video.id}] Saved to KV store — key: "${storageKey}"`);
                } catch (err) {
                    Actor.log.error(
                        `[${video.id}] Download failed: ${err.message}. `
                        + 'Record will be saved without a storageUrl.',
                    );
                }
            }

            await dataset.pushData(record);
        }
    }

    Actor.log.info('Actor finished successfully.');
});

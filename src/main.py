"""
TikTok Channel Downloader — Apify Actor

Scrapes public TikTok user channels using Playwright (async Chromium) and
optionally downloads MP4 video files and thumbnail images to the Apify
key-value store.

Entry point: ``python -m src.main``
"""

import asyncio
import re
from datetime import datetime, timezone

import httpx
from apify import Actor
from playwright.async_api import Page, async_playwright

# ---------------------------------------------------------------------------
# Chrome user-agent string shared by both the browser context and httpx client
# ---------------------------------------------------------------------------
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------


async def _get_text(page: Page, selector: str) -> str:
    """Query *selector* on *page* and return its trimmed inner text.

    Returns an empty string when the element is not found or any error occurs.
    """
    try:
        el = await page.query_selector(selector)
        if el is None:
            return ""
        return (await el.inner_text()).strip()
    except Exception:  # noqa: BLE001
        return ""


def _parse_stat(value: str) -> int | None:
    """Convert TikTok stat strings like '1.2M', '34.5K', '123' to int."""
    if not value:
        return None
    cleaned = value.strip().upper().replace(",", "")
    try:
        if cleaned.endswith("M"):
            return int(float(cleaned[:-1]) * 1_000_000)
        if cleaned.endswith("K"):
            return int(float(cleaned[:-1]) * 1_000)
        return int(float(cleaned))
    except ValueError:
        return None


async def _extract_video_url_from_page(page: Page) -> str | None:
    """Try to find the MP4 download URL from the currently loaded video page.

    First checks the ``<video>`` element's ``src`` attribute; if that fails it
    scans the raw page HTML for the ``downloadAddr`` JSON field.
    Returns ``None`` when neither strategy succeeds.
    """
    try:
        src = await page.eval_on_selector("video", "el => el.src")
        if isinstance(src, str) and src.startswith("http"):
            return src
    except Exception:  # noqa: BLE001
        pass

    try:
        content = await page.content()
        match = re.search(r'"downloadAddr":"(https://[^"]+\.mp4[^"]*)"', content)
        if match:
            return match.group(1).replace("\\u0026", "&")
    except Exception:  # noqa: BLE001
        pass

    return None


async def _extract_thumbnail_from_page(page: Page) -> str | None:
    """Extract the video cover/thumbnail URL from the raw page HTML.

    Searches for the ``cover`` JSON field in the serialised page state.
    Returns ``None`` when not found.
    """
    try:
        content = await page.content()
        match = re.search(r'"cover":"(https://[^"]+)"', content)
        if match:
            return match.group(1).replace("\\u0026", "&")
    except Exception:  # noqa: BLE001
        pass
    return None


async def _download_binary(url: str) -> bytes | None:
    """Download *url* and return the raw bytes, or ``None`` on failure.

    Uses a Windows Chrome user-agent and a TikTok referer header to avoid
    simple bot-detection on CDN URLs.
    """
    headers = {
        "User-Agent": _USER_AGENT,
        "Referer": "https://www.tiktok.com/",
    }
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=60) as client:
            resp = await client.get(url, headers=headers)
            if resp.status_code == 200:
                return resp.content
    except Exception:  # noqa: BLE001
        pass
    return None


# ---------------------------------------------------------------------------
# Per-video scraper
# ---------------------------------------------------------------------------


async def scrape_video(
    page: Page,
    video_url: str,
    video_data_map: dict[str, dict],
    download_mp4: bool,
    download_thumbnail: bool,
    username: str,
) -> dict | None:
    """Navigate to *video_url*, extract metadata, and optionally download media.

    API-intercepted data (from ``video_data_map``) is preferred for every
    field; DOM selectors are used as a fallback.

    Args:
        page: Playwright page object (reused across calls).
        video_url: Full TikTok video URL.
        video_data_map: Mapping of video ID → raw API item dict populated by
            the network response handler in :func:`main`.
        download_mp4: When ``True``, download the MP4 and save to KV store.
        download_thumbnail: When ``True``, download the thumbnail and save to
            KV store.
        username: The channel username (stored verbatim in the result).

    Returns:
        A result dict ready to be pushed to the Apify dataset, or ``None`` if
        the video ID cannot be determined.
    """
    # ------------------------------------------------------------------
    # 1. Extract the numeric video ID from the URL
    # ------------------------------------------------------------------
    id_match = re.search(r"/video/(\d+)", video_url)
    if not id_match:
        Actor.log.warning("Could not extract video ID from URL: %s", video_url)
        return None
    video_id = id_match.group(1)

    # ------------------------------------------------------------------
    # 2. Navigate to the video page
    # ------------------------------------------------------------------
    await page.goto(video_url, wait_until="domcontentloaded", timeout=45_000)
    await page.wait_for_timeout(2_500)

    # ------------------------------------------------------------------
    # 3. Look up any data captured from TikTok's internal API
    # ------------------------------------------------------------------
    api_data: dict = video_data_map.get(video_id, {})
    stats: dict = api_data.get("stats", {})
    music: dict = api_data.get("music", {})
    video_meta: dict = api_data.get("video", {})

    # ------------------------------------------------------------------
    # 4. Extract each field — API data first, DOM fallback second
    # ------------------------------------------------------------------

    # Description
    description: str = api_data.get("desc") or (
        await _get_text(page, '[data-e2e="browse-video-desc"]')
        or await _get_text(page, ".video-meta-title")
    )

    # Engagement stats — API integers already, DOM values need parsing
    likes: int | None = stats.get("diggCount") or _parse_stat(
        await _get_text(page, '[data-e2e="browse-like-count"]')
    )
    comments: int | None = stats.get("commentCount") or _parse_stat(
        await _get_text(page, '[data-e2e="browse-comment-count"]')
    )
    shares: int | None = stats.get("shareCount") or _parse_stat(
        await _get_text(page, '[data-e2e="share-count"]')
    )
    views: int | None = stats.get("playCount") or _parse_stat(
        await _get_text(page, '[data-e2e="video-views"]')
    )

    # Music metadata
    music_title: str = music.get("title") or await _get_text(
        page, '[class*="music-title"]'
    )
    music_author: str = music.get("authorName") or ""

    # Video play / download URL — prefer downloadAddr over playAddr
    video_play_url: str | None = (
        video_meta.get("downloadAddr")
        or video_meta.get("playAddr")
        or await _extract_video_url_from_page(page)
    )

    # Thumbnail
    thumbnail_url: str | None = (
        video_meta.get("cover")
        or video_meta.get("originCover")
        or await _extract_thumbnail_from_page(page)
    )

    # Date — convert Unix timestamp to "YYYY-MM-DD"
    create_time = api_data.get("createTime")
    date_str: str | None = None
    if create_time:
        try:
            date_str = datetime.fromtimestamp(int(create_time), tz=timezone.utc).strftime("%Y-%m-%d")
        except (ValueError, OSError):
            date_str = None

    # ------------------------------------------------------------------
    # 5. Build the result dict
    # ------------------------------------------------------------------
    result: dict = {
        "videoId": video_id,
        "url": video_url,
        "username": username,
        "description": description,
        "date": date_str,
        "likes": likes,
        "comments": comments,
        "shares": shares,
        "views": views,
        "musicTitle": music_title,
        "musicAuthor": music_author,
        "videoPlayUrl": video_play_url,
        "thumbnailUrl": thumbnail_url,
        "mp4StorageUrl": None,
        "thumbnailStorageUrl": None,
        "scrapedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }

    # ------------------------------------------------------------------
    # 6. Open the default key-value store once for both uploads
    # ------------------------------------------------------------------
    kv_store = await Actor.open_key_value_store()

    # ------------------------------------------------------------------
    # 7. Optionally download and store the MP4
    # ------------------------------------------------------------------
    if download_mp4 and video_play_url:
        mp4_data = await _download_binary(video_play_url)
        if mp4_data:
            mp4_key = f"video_{video_id}.mp4"
            await kv_store.set_value(mp4_key, mp4_data, content_type="video/mp4")
            # Build the public KV store record URL
            store_id = kv_store.id
            result["mp4StorageUrl"] = (
                f"https://api.apify.com/v2/key-value-stores/{store_id}/records/{mp4_key}"
            )
            Actor.log.info(
                "Stored MP4 for video %s (%.1f KB)", video_id, len(mp4_data) / 1024
            )
        else:
            Actor.log.warning("Failed to download MP4 for video %s", video_id)

    # ------------------------------------------------------------------
    # 8. Optionally download and store the thumbnail
    # ------------------------------------------------------------------
    if download_thumbnail and thumbnail_url:
        thumb_data = await _download_binary(thumbnail_url)
        if thumb_data:
            thumb_key = f"thumb_{video_id}.jpg"
            await kv_store.set_value(thumb_key, thumb_data, content_type="image/jpeg")
            store_id = kv_store.id
            result["thumbnailStorageUrl"] = (
                f"https://api.apify.com/v2/key-value-stores/{store_id}/records/{thumb_key}"
            )
            Actor.log.info(
                "Stored thumbnail for video %s (%.1f KB)",
                video_id,
                len(thumb_data) / 1024,
            )
        else:
            Actor.log.warning("Failed to download thumbnail for video %s", video_id)

    return result


# ---------------------------------------------------------------------------
# Main actor entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    """Apify Actor entry point — orchestrates the full scraping pipeline.

    Reads actor input, launches Playwright Chromium, scrolls the target
    TikTok channel to collect video URLs, scrapes each video, and pushes
    results to the Apify dataset.
    """
    async with Actor:
        # ------------------------------------------------------------------
        # 2. Read and validate input
        # ------------------------------------------------------------------
        actor_input: dict = await Actor.get_input() or {}

        raw_username: str = actor_input.get("username", "")
        username: str = raw_username.strip().lstrip("@")
        if not username:
            raise ValueError("'username' is required in input.")

        max_videos: int = int(actor_input.get("maxVideos", 20))
        download_mp4: bool = bool(actor_input.get("downloadMp4", True))
        download_thumbnail: bool = bool(actor_input.get("downloadThumbnail", True))
        headless: bool = bool(actor_input.get("headless", True))

        Actor.log.info(
            "Starting scrape for @%s — maxVideos=%d, downloadMp4=%s, "
            "downloadThumbnail=%s, headless=%s",
            username,
            max_videos,
            download_mp4,
            download_thumbnail,
            headless,
        )

        # ------------------------------------------------------------------
        # 3–4. Launch Playwright Chromium with anti-detection settings
        # ------------------------------------------------------------------
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(
                headless=headless,
                args=[
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-blink-features=AutomationControlled",
                ],
            )
            context = await browser.new_context(
                user_agent=_USER_AGENT,
                viewport={"width": 1280, "height": 800},
                locale="en-US",
            )

            # ------------------------------------------------------------------
            # 5. Shared map: video_id → raw API response item
            # ------------------------------------------------------------------
            video_data_map: dict[str, dict] = {}

            # ------------------------------------------------------------------
            # 6. Intercept TikTok's internal item_list API to grab rich metadata
            # ------------------------------------------------------------------
            async def handle_response(response) -> None:
                """Network response handler — captures TikTok API item lists."""
                url = response.url
                # Only process TikTok video list API endpoints
                if "api/post/item_list" not in url and not (
                    "api16" in url and "item_list" in url
                ):
                    return
                try:
                    body = await response.json()
                    items = body.get("itemList") or body.get("items") or []
                    for item in items:
                        vid_id = item.get("id") or item.get("video", {}).get("id")
                        if vid_id:
                            video_data_map[str(vid_id)] = item
                except Exception:  # noqa: BLE001
                    pass

            # ------------------------------------------------------------------
            # 7. Open the channel page and register the response listener
            # ------------------------------------------------------------------
            page = await context.new_page()
            page.on("response", handle_response)

            # ------------------------------------------------------------------
            # 8. Navigate to the user's TikTok channel
            # ------------------------------------------------------------------
            channel_url = f"https://www.tiktok.com/@{username}"
            Actor.log.info("Navigating to %s", channel_url)
            await page.goto(channel_url, wait_until="networkidle", timeout=60_000)
            # Give the page an extra moment for JS-rendered content to appear
            await page.wait_for_timeout(3_000)

            # ------------------------------------------------------------------
            # 9. Scroll loop — collect unique video URLs
            # ------------------------------------------------------------------
            collected_urls: list[str] = []
            scroll_attempts = 0

            while len(collected_urls) < max_videos:
                # Grab all video anchors visible on the page
                hrefs: list[str] = await page.eval_on_selector_all(
                    'a[href*="/@"][href*="/video/"]',
                    "els => els.map(e => e.href)",
                )

                previous_count = len(collected_urls)
                for href in hrefs:
                    if href not in collected_urls:
                        collected_urls.append(href)

                Actor.log.info(
                    "Collected %d/%d video URLs for @%s",
                    len(collected_urls),
                    max_videos,
                    username,
                )

                if len(collected_urls) >= max_videos:
                    break

                if len(collected_urls) == previous_count:
                    # No new URLs found — may have reached the end of the feed
                    scroll_attempts += 1
                else:
                    scroll_attempts = 0

                if scroll_attempts >= 30:
                    Actor.log.info(
                        "No new URLs after %d scroll attempts — end of feed.",
                        scroll_attempts,
                    )
                    break

                # Scroll down and wait for lazy-loaded content
                await page.evaluate("window.scrollBy(0, 1500)")
                await page.wait_for_timeout(2_000)

            # ------------------------------------------------------------------
            # 10. Respect the maxVideos cap
            # ------------------------------------------------------------------
            collected_urls = collected_urls[:max_videos]
            Actor.log.info(
                "Collected %d video URLs for @%s — starting detail scrape.",
                len(collected_urls),
                username,
            )

            # ------------------------------------------------------------------
            # 11. Scrape each video individually
            # ------------------------------------------------------------------
            saved_count = 0
            for video_url in collected_urls:
                try:
                    result = await scrape_video(
                        page=page,
                        video_url=video_url,
                        video_data_map=video_data_map,
                        download_mp4=download_mp4,
                        download_thumbnail=download_thumbnail,
                        username=username,
                    )
                    if result:
                        await Actor.push_data(result)
                        saved_count += 1
                except Exception as exc:  # noqa: BLE001
                    Actor.log.warning(
                        "Error scraping %s: %s", video_url, exc, exc_info=True
                    )

            # ------------------------------------------------------------------
            # 12. Shut down the browser and log the final tally
            # ------------------------------------------------------------------
            await browser.close()
            Actor.log.info(
                "Scraping complete — saved %d video records for @%s.",
                saved_count,
                username,
            )


if __name__ == "__main__":
    asyncio.run(main())

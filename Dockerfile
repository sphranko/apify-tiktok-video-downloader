# Lightweight Node.js 20 image (Alpine-based).
# yt-dlp handles TikTok's API signing and CDN authentication internally.
FROM apify/actor-node:20

# Copy dependency manifest first for Docker layer caching.
COPY package*.json ./
RUN npm install --omit=dev

# Install Python3 (yt-dlp runtime) and download yt-dlp itself.
RUN apk add --no-cache python3 && \
    python3 -c "import urllib.request; urllib.request.urlretrieve('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp', '/usr/local/bin/yt-dlp')" && \
    chmod +x /usr/local/bin/yt-dlp

COPY . ./

# Update yt-dlp to the latest version at each container startup, then run the actor.
# This ensures TikTok extractor fixes are always applied without requiring a rebuild.
CMD sh -c "yt-dlp -U --no-color 2>&1 | head -5 && node src/main.js"

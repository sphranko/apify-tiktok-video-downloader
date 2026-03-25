# Lightweight Node.js 20 image — no browser required.
# yt-dlp handles TikTok's API signing and CDN authentication internally.
FROM apify/actor-node:20

# Copy dependency manifest first for Docker layer caching.
COPY package*.json ./
RUN npm install --omit=dev

# Install Python3 (yt-dlp runtime) and download yt-dlp itself.
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends python3 ca-certificates && \
    python3 -c "import urllib.request; urllib.request.urlretrieve('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp', '/usr/local/bin/yt-dlp')" && \
    chmod +x /usr/local/bin/yt-dlp && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

COPY . ./
CMD ["node", "src/main.js"]

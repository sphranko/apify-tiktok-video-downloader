# Lightweight Node.js 20 image — no browser required.
# CheerioCrawler performs plain HTTP requests to TikTok's SSR endpoint,
# so Playwright / Chromium is not needed and the image stays small.
# See: https://hub.docker.com/r/apify/actor-node
FROM apify/actor-node:20

# Copy dependency manifest first to leverage Docker layer caching.
COPY package*.json ./

# Install production dependencies.
RUN npm install --omit=dev && \
    echo "Dependencies installed."

# Copy the rest of the actor source code.
COPY . ./

# Default command executed when the container starts.
CMD ["node", "src/main.js"]

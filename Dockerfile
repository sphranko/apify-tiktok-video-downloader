# Node.js 20 image with Playwright + Chromium pre-installed.
# Needed to render TikTok's JavaScript-heavy profile pages and intercept
# the internal API responses that carry video metadata.
# See: https://hub.docker.com/r/apify/actor-node-playwright-chrome
FROM apify/actor-node-playwright-chrome:20

# Copy dependency manifest first to leverage Docker layer caching.
COPY package*.json ./

# Install production dependencies.
# Playwright browser binaries are already in the base image.
RUN npm install --omit=dev && \
    echo "Dependencies installed."

# Copy the rest of the actor source code.
COPY . ./

# Default command executed when the container starts.
CMD ["node", "src/main.js"]

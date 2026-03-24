# Base image: Apify's Node.js 20 image with Playwright + Chromium pre-installed.
# See: https://hub.docker.com/r/apify/actor-node-playwright-chrome
FROM apify/actor-node-playwright-chrome:20

# Copy dependency manifest first to leverage Docker layer caching.
COPY package*.json ./

# Install Node dependencies.
# --omit=dev keeps the image lean; Playwright browser binaries are already
# bundled in the base image so we skip the post-install download step.
RUN npm install --omit=dev && \
    echo "Dependencies installed."

# Copy the rest of the actor source code.
COPY . ./

# Default command executed when the container starts.
CMD ["node", "src/main.js"]

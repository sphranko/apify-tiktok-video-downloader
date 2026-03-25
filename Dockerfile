# Lightweight Node.js 20 base image — no browser needed since scraping and
# downloading are handled via HTTP requests to the tikwm.com API.
# See: https://hub.docker.com/r/apify/actor-node
FROM apify/actor-node:20

# Copy dependency manifest first to leverage Docker layer caching.
COPY package*.json ./

# Install production dependencies only.
RUN npm install --omit=dev && \
    echo "Dependencies installed."

# Copy the rest of the actor source code.
COPY . ./

# Default command executed when the container starts.
CMD ["node", "src/main.js"]

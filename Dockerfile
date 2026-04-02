# Use Node 18 slim as base
FROM node:18-slim

# Install required system packages and Chrome
RUN apt-get update \
    && apt-get install -y \
       wget \
       gnupg \
       ca-certificates \
       fonts-liberation \
       libappindicator3-1 \
       libasound2 \
       libatk-bridge2.0-0 \
       libatk1.0-0 \
       libc6 \
       libcairo2 \
       libcups2 \
       libcurl4 \
       libdbus-1-3 \
       libexpat1 \
       libgbm1 \
       libglib2.0-0 \
       libgtk-3-0 \
       libnspr4 \
       libnss3 \
       libpango-1.0-0 \
       libpangocairo-1.0-0 \
       libx11-6 \
       libxcb1 \
       libxcomposite1 \
       libxcursor1 \
       libxdamage1 \
       libxext6 \
       libxfixes3 \
       libxi6 \
       libxrandr2 \
       libxrender1 \
       libxss1 \
       libxtst6 \
       xdg-utils \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set up working directory
WORKDIR /app

# Copy ALL source code first (ensures latest files always)
COPY . .

# Install dependencies
RUN npm ci

# Ensure all required directories exist and are writable
RUN mkdir -p /app/data /app/session /app/storage && \
    chmod -R 777 /app/data /app/session /app/storage && \
    chown -R 1000:1000 /app/data /app/session /app/storage

# Environment variables needed for Puppeteer to run headless Chrome in a container
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    CHROME_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    DASHBOARD_PORT=3000 \
    NODE_ENV=production

# Map Dashboard Port
EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "const http = require('http'); http.get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))" || exit 1

# Start the bot
CMD ["npm", "start"]

# Use Node 18 slim as base
FROM node:18-slim

# Install latest Chromium and dependencies
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set up working directory
WORKDIR /app

# Copy package.json and package-lock.json first
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy the rest of the app code
COPY . .

# Ensure data directory exists
RUN mkdir -p /app/data

# Environment variables needed for Puppeteer to run headless Chrome in a container
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
  PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
  CHROME_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Map Dashboard Port
ENV DASHBOARD_PORT=3000
EXPOSE 3000

# Start the bot
CMD ["npm", "start"]

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium ffmpeg ca-certificates fonts-liberation libnss3 libatk-bridge2.0-0 libgbm1 libasound2 libxss1 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    CHROMIUM_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=true \
    AUTH_DATA_PATH=/data/whatsapp-session
WORKDIR /app
COPY bot/package.json ./bot/package.json
RUN cd bot && npm install --omit=dev && npm cache clean --force
COPY index.html ./index.html
COPY bot/server.js ./bot/server.js
RUN mkdir -p /data/whatsapp-session && chown -R node:node /app /data
USER node
EXPOSE 3000
CMD ["node","bot/server.js"]

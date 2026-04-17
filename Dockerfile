FROM node:20-slim

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN npm install @whiskeysockets/baileys@7.0.0-rc.9 thread-stream@3.1.0

COPY artifacts/api-server/dist ./artifacts/api-server/dist

ENV NODE_ENV=production

CMD ["node", "artifacts/api-server/dist/index.mjs"]

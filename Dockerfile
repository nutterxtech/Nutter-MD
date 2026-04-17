FROM node:20-slim

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    libssl-dev \
    libvips-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./

RUN npm install --production

COPY artifacts/api-server/dist ./artifacts/api-server/dist

ENV NODE_ENV=production

CMD ["node", "artifacts/api-server/dist/index.mjs"]

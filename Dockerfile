FROM node:20-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update -qq > /dev/null 2>&1 \
    && apt-get install -y -qq --no-install-recommends \
        ca-certificates \
        git \
        python3 \
        make \
        g++ \
        libssl-dev \
        > /dev/null 2>&1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV GIT_SSL_NO_VERIFY=true
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
    && git config --global http.sslVerify false

# Install pnpm globally
RUN npm install -g pnpm --loglevel=error --no-fund --no-audit

# Copy package files first for better layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY artifacts/api-server/package.json ./artifacts/api-server/
COPY artifacts/nutter-xmd/package.json ./artifacts/nutter-xmd/

# Install all dependencies
RUN pnpm install --frozen-lockfile --prod=false

# Copy full source
COPY . .

# Build both packages from source
RUN pnpm --filter @workspace/nutter-xmd run build \
    && pnpm --filter @workspace/api-server run build

ENV NODE_ENV=production

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]

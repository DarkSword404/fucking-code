FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* tsconfig.json vitest.config.ts ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts

RUN npm install --no-audit --no-fund
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0

EXPOSE 8787

CMD ["npm", "start"]

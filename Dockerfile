# Multi-stage build for game-bots. Build stage compiles TypeScript
# to dist/; runtime stage ships only production deps and compiled JS.
# The container is a headless Node process: no exposed port, no
# healthcheck. Pass GAME_BOTS_INLINE_CONFIG (raw JSON) at runtime,
# or mount a config.json into /app.
FROM node:22-alpine AS build
# git is needed by npm to resolve the @cellagents/game-protocol
# dependency, which is served as a tagged ref off its GitHub repo.
RUN apk add --no-cache git
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
RUN apk add --no-cache git
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
# Shipped defaults; env vars or mounted config.json override at runtime.
COPY config.example.json ./config.example.json
CMD ["node", "dist/index.js"]

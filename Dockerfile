# --- build stage ------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# git: install the pinned mcp-oda dep from GitHub (its "prepare" hook compiles it).
# python3/make/g++: node-gyp toolchain to build the better-sqlite3 native addon.
RUN apk add --no-cache git python3 make g++

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json tsconfig.scripts.json ./
COPY src ./src
COPY scripts ./scripts
# tests/ is dockerignored from the runtime image, but the build stage needs the
# shared fixtures (tests/fixtures/scenarios.ts) that scripts/experiment.ts imports.
COPY tests ./tests
RUN npm run build
# Separately compiled (own rootDir/outDir) so the seed script — run as a one-off
# task on the swarm node, see .github/workflows/seed-history.yml — doesn't need
# tsx/ts-node at runtime, without disturbing dist/'s existing flat layout.
RUN npm run build:scripts

# --- runtime stage ----------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# node_modules (incl. the already-built mcp-oda) and compiled output.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-scripts ./dist-scripts
COPY package.json ./
COPY preferences.json ./

# mcp-oda cookie session persists here (mount a volume at /data in prod).
ENV MCP_ODA_DATA_DIR=/data/.mcp-oda
RUN mkdir -p /data

CMD ["node", "dist/index.js"]

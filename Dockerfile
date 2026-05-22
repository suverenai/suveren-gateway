# Build the same artifact as the npm distribution (`bundle/dist/`) and
# ship it under tini. One source of truth — the npm path and Docker
# image differ only in their supervisor wrapper (npm CLI vs. tini +
# `node server.js`).
#
# ─── Build stage ────────────────────────────────────────────────────────────
FROM node:22-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /build
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/ packages/
COPY apps/ apps/
COPY bundle/ bundle/

RUN pnpm install --frozen-lockfile 2>/dev/null || pnpm install
RUN pnpm build

# Assemble the publishable bundle. Output: /build/bundle/dist/
RUN node bundle/build.mjs

# Pull profiles in the build stage so the production image needs no git.
RUN git clone --depth 1 https://github.com/humanagencyprotocol/hap-profiles.git /hap-profiles \
    && rm -rf /hap-profiles/.git

# ─── Production stage ──────────────────────────────────────────────────────
FROM node:22-slim AS production

RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The bundle assembled by the build stage is the entire production tree:
#   /app/server.js            supervisor entry (== `node bin/hap-gateway.js`'s server)
#   /app/bin/hap-gateway.js   CLI (unused inside Docker but harmless)
#   /app/dist/ui/             static UI
#   /app/dist/control-plane/  built CP
#   /app/dist/mcp-server/     built MCP server
#   /app/package.json         flat runtime deps (workspace alias rewritten)
COPY --from=build /build/bundle/dist/ /app/

# Install only the runtime deps declared in the bundle's flat package.json.
# No pnpm workspace, no devDeps. The `@hap/core` workspace alias was
# rewritten to `npm:@humanagencyp/hap-core@<pin>` by bundle/build.mjs so
# this resolves cleanly without any source-code rewriting.
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Pre-install the integration MCP servers globally so the first
# user-driven enable in the UI doesn't hit npm. The integration manager's
# PATH includes /usr/local/lib/node_modules/.bin (Docker default).
RUN npm install -g mcp-remote @humanagencyp/linkedin-mcp @humanagencyp/crm-mcp @humanagencyp/records-mcp @shinzolabs/gmail-mcp \
    && npm cache clean --force

# Integration manifests (read-only source the gateway lists in the UI).
# Distinct from /app/integrations which is a writable runtime install dir.
COPY content/integrations/ /app/content/integrations/

# Profiles
COPY --from=build /hap-profiles /hap-profiles

# Mount points
RUN mkdir -p /app/data /app/integrations

ARG GIT_SHA=dev
ENV HAP_BUILD_SHA=$GIT_SHA
ENV HAP_UI_DIST=/app/dist/ui
ENV SUVEREN_DATA_DIR=/app/data
ENV SUVEREN_CP_PORT=3000
ENV SUVEREN_MCP_PORT=3030
ENV SUVEREN_MCP_INTERNAL_URL=http://127.0.0.1:3030
ENV SUVEREN_MANIFESTS_DIR=/app/content/integrations
ENV SUVEREN_INTEGRATIONS_DIR=/app/integrations
ENV SUVEREN_PROFILES_DIR=/hap-profiles
ENV NODE_ENV=production

EXPOSE 3000 3030

# tini handles PID 1 / signal forwarding; server.js supervises the two
# child processes (CP + MCP) and propagates SIGINT/SIGTERM to them.
ENTRYPOINT ["tini", "--"]
CMD ["node", "/app/server.js"]

# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS builder

ARG PNPM_VERSION=11.3.0
WORKDIR /app
RUN npm install --global "pnpm@${PNPM_VERSION}"

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsup.config.ts ./
RUN pnpm install --frozen-lockfile
COPY src ./src
RUN pnpm run build && pnpm prune --prod

# Dedicated sync image. It owns Obsidian credentials and is never used as the MCP runtime.
FROM node:22-alpine AS obsidian-sync
RUN npm install --global "obsidian-headless@0.0.14" && \
    mkdir -p /vault /home/obsidian && \
    chown -R node:node /vault /home/obsidian
ENV HOME=/home/obsidian \
    XDG_CONFIG_HOME=/home/obsidian/.config \
    XDG_DATA_HOME=/home/obsidian/.local/share \
    XDG_CACHE_HOME=/home/obsidian/.cache
USER node
ENTRYPOINT ["ob"]

# MCP image. It contains no ob binary and no X credentials.
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    OBSIDIAN_VAULT_PATH=/workspace
RUN mkdir -p /workspace/blogs && \
    chown -R node:node /app /workspace /home/node
COPY --from=builder --chown=node:node /app/package.json ./
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
USER node
EXPOSE 8080
ENTRYPOINT ["node", "dist/index.js"]

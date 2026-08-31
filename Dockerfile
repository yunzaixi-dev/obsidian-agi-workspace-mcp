# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

RUN npm install -g pnpm@10

COPY package.json pnpm-lock.yaml* tsconfig.json tsup.config.ts ./
COPY src ./src

RUN pnpm install --frozen-lockfile=false && \
    pnpm run build

# Production stage
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV OBSIDIAN_VAULT_PATH=/vault

# Create non-root user and vault directory
RUN addgroup -g 1000 nodejs && \
    adduser -S -u 1000 -G nodejs mcp && \
    mkdir -p /vault && \
    chown -R mcp:nodejs /app /vault

COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

USER mcp

EXPOSE 8080

ENTRYPOINT ["node", "dist/index.js"]

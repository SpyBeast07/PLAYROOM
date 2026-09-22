# ------------------------------------------------------------------------------
# Production Dockerfile for PLAYROOM Backend (Bun + Hono + WebSockets)
# ------------------------------------------------------------------------------

# Stage 1: Base image
FROM oven/bun:1-slim AS base
WORKDIR /app

# Stage 2: Install production dependencies
FROM base AS dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Stage 3: Production runner
FROM base AS runner

ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0

# Run as non-root bun user provided by official oven/bun image
USER bun

# Copy installed production dependencies and source files
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json tsconfig.json ./
COPY --chown=bun:bun src ./src

# Expose internal container port
EXPOSE 8787

# Lightweight health check using Bun's built-in fetch against /health
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:8787/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Start the application directly (receives SIGTERM/SIGINT cleanly)
CMD ["bun", "src/index.ts"]

# NSE Options Paper Trading System - Docker Image
# Multi-stage build for smaller final image

# ============================================================================
# Stage 1: Build
# ============================================================================
FROM node:20-alpine AS builder

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++ git

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install all dependencies (including dev)
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src ./src
COPY config ./config

# Build TypeScript
RUN npm run build

# ============================================================================
# Stage 2: Production
# ============================================================================
FROM node:20-alpine AS production

# Install runtime dependencies for native modules
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Create data directory for SQLite and logs
RUN mkdir -p /app/data /app/logs

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production && \
    npm cache clean --force

# Remove build tools after native module compilation
RUN apk del python3 make g++

# Copy built files from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/config ./config

# Copy additional files needed at runtime
COPY .env.example ./.env.example

# Environment variables with defaults
ENV NODE_ENV=production \
    LOG_LEVEL=info \
    DATABASE_PATH=/app/data/paper-trading.db

# Volume for persistent data
VOLUME ["/app/data", "/app/logs"]

# Expose webhook port (optional)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "console.log('healthy')" || exit 1

# Default command - run CLI
CMD ["node", "dist/cli/index.js", "start"]

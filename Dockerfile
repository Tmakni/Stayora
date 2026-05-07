# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy dependencies and app code
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Cloud Run injects PORT (default 8080); the app reads process.env.PORT
EXPOSE 8080

USER appuser

CMD ["node", "server/server.js"]

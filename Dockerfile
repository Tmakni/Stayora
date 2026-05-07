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

# Create the SQLite DB directory with correct ownership
RUN mkdir -p /home/appuser/.local/share/airbnb-ai-agent \
    && chown -R appuser:appgroup /home/appuser/.local

# Copy dependencies and app code
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Give appuser ownership of the entire app
RUN chown -R appuser:appgroup /app

# Cloud Run injects PORT (default 8080); the app reads process.env.PORT
EXPOSE 8080

USER appuser

CMD ["node", "server/server.js"]

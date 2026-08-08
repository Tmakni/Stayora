# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# ── Client build stage ───────────────────────────────────────────────────────
FROM node:20-alpine AS client-build

WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Create the SQLite DB directories with correct ownership
# /data = Render persistent disk mount point (production)
# ~/.local/share/... = fallback for local dev
RUN mkdir -p /home/appuser/.local/share/airbnb-ai-agent /data \
    && chown -R appuser:appgroup /home/appuser/.local /data

# Copy dependencies and app code
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Replace the raw client source with the compiled SPA (client/dist)
RUN rm -rf client/src client/node_modules
COPY --from=client-build /app/client/dist ./client/dist

# Give appuser ownership of the entire app
RUN chown -R appuser:appgroup /app

# Cloud Run injects PORT (default 8080); the app reads process.env.PORT
EXPOSE 8080

USER appuser

CMD ["node", "server/server.js"]

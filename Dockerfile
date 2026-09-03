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

# Chromium, pour lire les annonces d'un profil hôte Airbnb.
#
# Airbnb ne livre plus ces annonces dans le HTML : la page arrive vide et se
# remplit en JavaScript. Il faut donc exécuter la page, pas l'analyser.
# Mesuré sur une page réelle : requête HTTP = 0 annonce, navigateur = 10.
#
# C'est le paquet Chromium d'Alpine, PAS un navigateur téléchargé par
# Playwright : ses binaires sont compilés pour glibc et ne tournent pas sur
# musl. `puppeteer-core` se contente d'un binaire système, d'où ce choix — il
# évite de changer l'image de base pour Debian et les ~400 Mo qui vont avec.
#
# nss, freetype et harfbuzz ne sont pas décoratifs : sans eux Chromium démarre
# puis meurt au premier rendu de texte.
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont

# Emplacement du binaire, lu par services/airbnbProfileBrowser.js. Le poser ici
# évite de dépendre de l'ordre de la liste de candidats du module.
ENV CHROME_PATH=/usr/bin/chromium-browser

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

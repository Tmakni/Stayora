const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const config = require('./config/env');
const { initDatabase } = require('./config/db');
const { ensureBetterSqlite3 } = require('../scripts/ensure-native-modules');
const logger = require('./utils/logger');

const authRoutes = require('./routes/auth');
const conversationRoutes = require('./routes/conversations');
const aiRoutes = require('./routes/ai');
const propertyRoutes = require('./routes/properties');
const webhookRoutes = require('./routes/webhooks');
const syncRoutes = require('./routes/sync');
const gmailRoutes = require('./routes/gmail');
const calendarRoutes = require('./routes/calendar');
const settingsRoutes = require('./routes/settings');
const { startScheduler } = require('./services/syncScheduler');
const replyWorker = require('./services/replyWorker');

const app = express();
let isAppReady = false;
let startupError = null;

// Trust first proxy (nginx, cloudflare, etc.) for correct IP in rate limiting
app.set('trust proxy', 1);

// ================================================================
// SECURITY MIDDLEWARE
// ================================================================

// Helmet — full security headers with Content-Security-Policy
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // 'unsafe-inline' only covers the tiny theme-flash-prevention <script> in
      // index.html — the React bundle itself is loaded from a same-origin file.
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      // OpenAI is only ever called server-side (server/services/aiService.js
      // via the official SDK) — the browser never talks to api.openai.com
      // directly, so it does not belong in connect-src. 'self' covers the
      // client's own fetch()/EventSource calls (client/src/lib/api.js,
      // client/src/lib/useSSE.js), which are all same-origin.
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      ...(config.isProd ? { upgradeInsecureRequests: [] } : {}),
    }
  },
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  noSniff: true,
  xssFilter: true,
  // Prevent page from being loaded in iframes (clickjacking)
  frameguard: { action: 'deny' },
}));

// CORS — strict origin control
// Render auto-sets RENDER_EXTERNAL_URL; Railway auto-sets RAILWAY_PUBLIC_DOMAIN
// (bare hostname, no scheme — Railway public domains are always https).
// APP_URL can override for custom domains.
const _prodOrigins = [
  process.env.APP_URL,
  process.env.RENDER_EXTERNAL_URL,
  process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`,
].filter(Boolean).map(o => o.replace(/\/$/, ''));
// In development the app is also opened from a phone on the same Wi-Fi
// (`npm run dev:mobile`), so the browser's Origin is the machine's LAN address
// — http://192.168.x.x:5173 — not localhost. A hardcoded list can't know that
// address, so dev accepts loopback and PRIVATE-RANGE origins only. This branch
// is unreachable in production, where the explicit allowlist above applies.
const DEV_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$/;

const allowedOrigins = config.isProd
  ? (_prodOrigins.length > 0 ? _prodOrigins : null)
  : null;

if (config.isProd && !allowedOrigins) {
  // Impossible-to-miss startup warning: without an explicit allowlist we do
  // NOT open CORS to the whole internet (that would defeat credentials:true —
  // any site could issue credentialed requests). Instead every request's
  // Origin is compared against ITS OWN Host header below, so only the app's
  // own deployed origin is allowed. This keeps a first deploy from being
  // locked out of its own frontend, but it is not a real allowlist — set
  // APP_URL (or ensure RENDER_EXTERNAL_URL is populated) as soon as possible.
  logger.warn('='.repeat(72));
  logger.warn('CORS WARNING: neither APP_URL nor RENDER_EXTERNAL_URL is set in production.');
  logger.warn('Falling back to same-origin-only CORS derived from each request\'s Host header.');
  logger.warn('Set APP_URL to your public URL to use a real allowlist instead.');
  logger.warn('='.repeat(72));
}

const _corsShared = {
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
};

app.use(cors((req, cb) => {
  const origin = req.headers.origin;

  // Allow server-to-server requests (no Origin header)
  if (!origin) return cb(null, { ..._corsShared, origin: true });

  // Development: accept loopback and private-LAN origins so the app can be
  // opened from a phone on the same Wi-Fi via the Vite dev server.
  if (!config.isProd) {
    if (DEV_ORIGIN_RE.test(origin)) return cb(null, { ..._corsShared, origin: true });
    logger.warn(`CORS blocked non-local origin in development: ${origin}`);
    return cb(new Error('CORS not allowed'));
  }

  if (allowedOrigins) {
    if (allowedOrigins.includes(origin)) return cb(null, { ..._corsShared, origin: true });
    logger.warn(`CORS blocked origin: ${origin}`);
    return cb(new Error('CORS not allowed'));
  }

  // No allowlist configured (prod without APP_URL/RENDER_EXTERNAL_URL): fail
  // closed against arbitrary third-party origins, but still allow the app's
  // own origin — the SPA and API are served from the same host/port in this
  // app, so this never blocks legitimate same-app requests.
  const selfOrigin = `${req.protocol}://${req.get('host')}`;
  if (origin === selfOrigin) return cb(null, { ..._corsShared, origin: true });
  logger.warn(`CORS blocked origin (no APP_URL/RENDER_EXTERNAL_URL configured): ${origin}`);
  return cb(new Error('CORS not allowed'));
}));

// Global rate limiter — 200 requests per minute per IP
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
  skip: (req) => req.path === '/api/health',
});
app.use('/api/', globalLimiter);

// Compress all responses > 1KB
app.use(compression({ level: 6, threshold: 1024 }));

// Body parsing with size limits
// Only compute rawBody for webhook routes (needed for signature verification)
app.use('/api/webhook', express.json({
  limit: '1mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); }
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(cookieParser());

// Serve the built React SPA (client/dist — produced by `npm run build` in client/)
const CLIENT_DIST = path.join(__dirname, '../client/dist');
app.use(express.static(CLIENT_DIST, {
  maxAge: config.isProd ? '7d' : 0,
  etag: true,
  lastModified: true,
  immutable: config.isProd,
  dotfiles: 'deny', // Block .env, .git, etc.
}));

// API Routes
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  if (startupError) {
    // startupError.message can contain internal details (DB host/user,
    // driver error text — see config/db.js's "Original error: ..." wrapping)
    // that must never reach an unauthenticated client. Full detail is
    // already logged server-side by initializeApp()/initDatabase(); only
    // echo it back to the caller outside production, where it's a debugging
    // convenience, not an information leak.
    return res.status(500).json({
      error: 'Server startup failed',
      ...(config.isProd ? {} : { details: startupError.message }),
    });
  }
  if (!isAppReady) {
    return res.status(503).json({ error: 'Server is starting, please retry in a few seconds' });
  }
  return next();
});

app.use('/api/auth', authRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/properties', propertyRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/gmail', gmailRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/settings', settingsRoutes);

// Health check
app.get('/api/health', (req, res) => {
  if (startupError) {
    // Same rationale as the /api readiness gate above: don't leak internal
    // DB/connection error text to this public, unauthenticated, un-rate-limited
    // monitoring endpoint in production.
    return res.status(500).json({
      status: 'error',
      ready: false,
      error: config.isProd ? 'Server startup failed' : startupError.message,
      timestamp: new Date().toISOString()
    });
  }
  // La cible de la base est exposee ici parce que la question « mes donnees
  // survivent-elles au deploiement ? » doit avoir une reponse verifiable sans
  // ouvrir les journaux. Aucun secret n'y figure : ni mot de passe, ni URL de
  // connexion, seulement le moteur, l'emplacement et le caractere persistant
  // (voir server/config/persistence.js).
  let database;
  try {
    database = require('./db/database').describeTarget();
  } catch (_) {
    database = null;
  }

  return res.json({
    status: isAppReady ? 'ok' : 'starting',
    ready: isAppReady,
    database: database
      ? { engine: database.engine, persistent: database.persistent, location: database.location }
      : undefined,
    timestamp: new Date().toISOString()
  });
});

// SPA fallback — React Router handles the actual routing client-side
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// Global error handler — never leak internals
app.use((err, req, res, _next) => {
  // Log full error for debugging
  logger.error('Unhandled error:', err.message);
  const status = err.status || 500;
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : err.message,
  });
});

// Runs DB migrations, flips isAppReady, starts the background sync scheduler.
// Split out from start() so tests can bring the app to a "ready" state
// in-process (via supertest) without ever binding a real network port.
async function initializeApp() {
  try {
    // Modules natifs AVANT toute ouverture de base.
    //
    // better-sqlite3 est compile pour UN systeme, et ce depot se lance tantot
    // depuis Windows, tantot depuis WSL, sur le meme node_modules. Sans ce
    // controle, l'incompatibilite ne se voyait qu'au premier acces a la base et
    // ressortait en « Database connection failed: invalid ELF header » — un
    // message qui envoie chercher un probleme de connexion inexistant.
    //
    // Le hook prestart de package.json ne couvrait pas ce cas : run-server.sh et
    // start-server.sh appellent `node server/server.js` directement.
    const native = ensureBetterSqlite3({ log: (m) => logger.info(m) });
    if (!native.ok) {
      throw new Error(
        `Module natif better-sqlite3 inutilisable sur cette plateforme : ${native.error && native.error.message}`
      );
    }

    await initDatabase();
    isAppReady = true;
    logger.info('Database initialized');
    startScheduler();
    // Drains the outbound reply queue. Runs in-process: Render's Starter web
    // service stays up 24/7 (only the Free plan spins down), so a separate
    // worker service would add cost without adding reliability. Claiming a row
    // is a conditional UPDATE, so this stays correct even if two instances run.
    replyWorker.start();
    logger.info('Application is ready');
  } catch (error) {
    startupError = error;
    logger.error('Failed to finish startup:', error);
  }
}

/**
 * Turns the raw "Unhandled 'error' event ... EADDRINUSE" stack trace into an
 * actionable message. On this project's usual Windows+WSL setup the port is
 * often held not by another server but by a `netsh portproxy` rule, which makes
 * iphlpsvc occupy the port on the Windows side permanently — so a Windows-side
 * launch can never bind it no matter what is killed.
 */
function probeExistingServer(port) {
  // Is the port held by OUR server, already up and serving? That is the common
  // case on this setup and it needs no action at all — telling the user to kill
  // processes would take down the very server they are trying to start.
  return new Promise((resolve) => {
    const req = require('http').get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: 1500 },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve(parsed && parsed.status === 'ok' ? parsed : null);
          } catch (_) { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function explainListenError(err) {
  if (err.code !== 'EADDRINUSE') {
    logger.error('Server failed to start:', err.message);
    process.exit(1);
  }

  const running = await probeExistingServer(config.port);

  if (running) {
    console.error([
      '',
      '='.repeat(70),
      `Le serveur repond DEJA sur http://localhost:${config.port} — rien a faire.`,
      '='.repeat(70),
      '',
      `  etat : ${running.ready ? 'pret' : 'demarrage en cours'}`,
      '',
      '  Une instance tourne deja (souvent lancee depuis WSL, exposee cote',
      '  Windows par une regle "netsh portproxy"). Ouvrez simplement l\'app.',
      '',
      '  ATTENTION — Windows et WSL n\'utilisent PAS la meme base SQLite :',
      `    Windows : ${require('path').join(__dirname, '..', 'data', 'airbnb_ai_agent.db')}`,
      '    WSL     : ~/.local/share/airbnb-ai-agent/airbnb_ai_agent.db',
      '  Vos donnees reelles sont dans celle de l\'instance qui tourne.',
      '  Lancer l\'autre cote afficherait une base differente, pas un bug.',
      '',
      '  Pour arreter l\'instance en cours :  npm run stop',
      '='.repeat(70),
      '',
    ].join('\n'));
    process.exit(0);
  }

  const lines = [
    '',
    '='.repeat(70),
    `Le port ${config.port} est deja utilise — le serveur ne peut pas demarrer.`,
    '='.repeat(70),
    '',
    'Le port est pris, mais rien ne repond sur /api/health : ce n\'est donc',
    'pas une instance saine de cette application.',
    '',
    'Causes possibles :',
    '  1. Une autre instance du serveur tourne deja (ou est bloquee).',
    '     -> Verifiez avec :  npx kill-port ' + config.port,
    '        ou, sous WSL :   pkill -f "node server/server.js"',
    '',
  ];

  if (process.platform === 'win32') {
    lines.push(
      '  2. Vous lancez depuis WINDOWS alors qu\'une regle "netsh portproxy"',
      '     redirige ce port vers WSL. Dans ce cas Windows occupe le port en',
      '     permanence et AUCUN lancement cote Windows ne fonctionnera.',
      '     -> Verifiez avec :  netsh interface portproxy show all',
      '     -> Solution A : lancez le serveur depuis WSL a la place.',
      '     -> Solution B : supprimez la regle (PowerShell administrateur) :',
      `        netsh interface portproxy delete v4tov4 listenport=${config.port} listenaddress=0.0.0.0`,
      '',
    );
  }

  lines.push(
    `  3. Utilisez simplement un autre port :  PORT=3001 npm start`,
    '='.repeat(70),
    '',
  );

  console.error(lines.join('\n'));
  process.exit(1);
}

// Initialize and start server
async function start() {
  const server = app.listen(config.port, '0.0.0.0', () => {
    logger.info(`Server running on http://localhost:${config.port}`);
    logger.info(`Environment: ${config.nodeEnv}`);
    logger.info('Initializing database in background...');
    initializeApp();
  });

  // Without this, a busy port surfaces as an unhandled 'error' event and a
  // raw stack trace; explainListenError() prints what to actually do instead.
  server.on('error', explainListenError);

  // Keep-alive: 65s ensures connections stay open behind nginx/proxies
  // (nginx default is 75s, so 65s avoids 502 race conditions)
  server.keepAliveTimeout = 65000;
  // headersTimeout must be > keepAliveTimeout to avoid ERR_EMPTY_RESPONSE
  server.headersTimeout = 66000;
  // Limit how long a request body can take to arrive (prevents slow-body DoS)
  server.requestTimeout = 30000;

  return server;
}

// Only auto-start when run directly (`node server/server.js`), not when
// `require()`'d — lets integration tests import `app`, call initializeApp()
// themselves, and drive it with supertest (in-process, no real socket)
// without fighting over the port.
if (require.main === module) {
  start();
}

module.exports = app;
module.exports.start = start;
module.exports.initializeApp = initializeApp;
// Self-reference so `const { app } = require('../server')` works too — without
// it that destructure silently yields undefined, since the export IS the app.
module.exports.app = app;

const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const config = require('./config/env');
const { initDatabase } = require('./config/db');
const logger = require('./utils/logger');

const authRoutes = require('./routes/auth');
const conversationRoutes = require('./routes/conversations');
const aiRoutes = require('./routes/ai');
const propertyRoutes = require('./routes/properties');
const webhookRoutes = require('./routes/webhooks');
const syncRoutes = require('./routes/sync');
const gmailRoutes = require('./routes/gmail');
const calendarRoutes = require('./routes/calendar');
const { startScheduler } = require('./services/syncScheduler');

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
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://api.openai.com"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      upgradeInsecureRequests: config.isProd ? [] : undefined,
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
// Render auto-sets RENDER_EXTERNAL_URL; APP_URL can override for custom domains
const _prodOrigins = [
  process.env.APP_URL,
  process.env.RENDER_EXTERNAL_URL,
].filter(Boolean).map(o => o.replace(/\/$/, ''));
const allowedOrigins = config.isProd
  ? (_prodOrigins.length > 0 ? _prodOrigins : null)
  : ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://192.168.1.21:3000'];

app.use(cors({
  origin: (origin, cb) => {
    // Allow server-to-server requests (no Origin header)
    if (!origin) return cb(null, true);
    // Fallback: if no origins configured in prod, allow all (prevents lockout on first deploy)
    if (!allowedOrigins) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    logger.warn(`CORS blocked origin: ${origin}`);
    cb(new Error('CORS not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
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

// Serve static files with caching
app.use(express.static(path.join(__dirname, '../client'), {
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
    return res.status(500).json({ error: 'Server startup failed', details: startupError.message });
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

// Health check
app.get('/api/health', (req, res) => {
  if (startupError) {
    return res.status(500).json({
      status: 'error',
      ready: false,
      error: startupError.message,
      timestamp: new Date().toISOString()
    });
  }
  return res.json({
    status: isAppReady ? 'ok' : 'starting',
    ready: isAppReady,
    timestamp: new Date().toISOString()
  });
});

// SPA fallback
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '../client/index.html'));
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

// Initialize and start server
async function start() {
  const server = app.listen(config.port, '0.0.0.0', async () => {
    logger.info(`Server running on http://localhost:${config.port}`);
    logger.info(`Environment: ${config.nodeEnv}`);
    logger.info('Initializing database in background...');

    try {
      await initDatabase();
      isAppReady = true;
      logger.info('Database initialized');
      startScheduler();
      logger.info('Application is ready');
    } catch (error) {
      startupError = error;
      logger.error('Failed to finish startup:', error);
    }
  });

  // Keep-alive: 65s ensures connections stay open behind nginx/proxies
  // (nginx default is 75s, so 65s avoids 502 race conditions)
  server.keepAliveTimeout = 65000;
  // headersTimeout must be > keepAliveTimeout to avoid ERR_EMPTY_RESPONSE
  server.headersTimeout = 66000;
  // Limit how long a request body can take to arrive (prevents slow-body DoS)
  server.requestTimeout = 30000;
}

start();

module.exports = app;

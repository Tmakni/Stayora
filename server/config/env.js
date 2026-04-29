require('dotenv').config();

const nodeEnv = process.env.NODE_ENV || 'development';
const isProd = nodeEnv === 'production';

// ── Critical secret validation ──────────────────────────────────
// In production, NEVER allow default secrets — fail fast.
const jwtSecret = process.env.JWT_SECRET || (isProd ? undefined : 'dev-only-secret-NOT-FOR-PROD');
const encryptionKey = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || (isProd ? undefined : 'dev-only-enc-key-NOT-FOR-PROD');

if (isProd && (!jwtSecret || jwtSecret.length < 32)) {
  console.error('FATAL: JWT_SECRET must be set and >= 32 characters in production.');
  process.exit(1);
}
if (isProd && (!encryptionKey || encryptionKey.length < 32)) {
  console.error('FATAL: ENCRYPTION_KEY must be set and >= 32 characters in production.');
  process.exit(1);
}

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv,
  isProd,
  jwt: {
    secret: jwtSecret,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini'
  },
  encryption: {
    key: encryptionKey
  },
  database: {
    useMemory: process.env.USE_MEMORY_DB === 'true',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'airbnb_ai_agent'
  },
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000,
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 30
  },
  superhot: {
    apiKey:        process.env.SUPERHOT_API_KEY       || '',
    accountKey:    process.env.SUPERHOT_ACCOUNT_KEY   || '',
    webhookSecret: process.env.SUPERHOT_WEBHOOK_SECRET || ''
  },
  google: {
    clientId:     process.env.GOOGLE_CLIENT_ID     || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri:  process.env.GOOGLE_REDIRECT_URI  || 'http://localhost:3000/api/gmail/oauth-callback'
  }
};

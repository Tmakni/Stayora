const rateLimit = require('express-rate-limit');
const config = require('../config/env');

// Rate limiter for AI draft generation — per user IP
const aiRateLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  message: { error: 'Too many AI requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict rate limiter for login/register — brute force protection
// 10 attempts per 15 minutes per IP
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Only count failed attempts
});

// Rate limiter for import/scraping endpoints — heavy operations
const importRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 5,
  message: { error: 'Too many import requests. Please wait a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  aiRateLimiter,
  authRateLimiter,
  importRateLimiter,
};

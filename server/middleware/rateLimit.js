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

// Password-reset requests — 5 per hour per IP.
// Deliberately does NOT set skipSuccessfulRequests: /forgot-password always
// answers 200 (so it never reveals whether an email is registered), which means
// authRateLimiter would count zero of its requests and leave the route wide
// open to email-bombing an arbitrary address.
const passwordResetRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Trop de demandes de réinitialisation. Réessayez dans une heure.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for import/scraping endpoints — heavy operations
const importRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 5,
  message: { error: 'Too many import requests. Please wait a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Limiteur propre a l'import d'archive.
//
// Il ne partage PAS le compteur d'importRateLimiter (5 requetes / 5 min) : ce
// dernier protege les endpoints qui vont interroger Airbnb, ou chaque appel
// part sur le reseau. Ici, le cout est local — decompression et lecture JSON en
// memoire, deja bornees par services/zipReader.js — et le parcours normal
// enchaine plusieurs appels : previsualisation, correction de la selection,
// import, puis souvent une seconde archive. Cinq requetes par 5 minutes
// bloquaient un hote de bonne foi des sa premiere tentative.
const archiveImportRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: "Trop d'imports d'archive. Patientez quelques minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  aiRateLimiter,
  authRateLimiter,
  passwordResetRateLimiter,
  importRateLimiter,
  archiveImportRateLimiter,
};

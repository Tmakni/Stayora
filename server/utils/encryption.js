/**
 * Encryption utility for securing sensitive data (API tokens, credentials)
 * Uses AES-256-GCM — authenticated encryption preventing tampering
 */
const crypto = require('crypto');
const config = require('../config/env');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT_LENGTH = 32;

/**
 * Derived-key memo.
 *
 * deriveKey() is 100 000 rounds of PBKDF2-SHA512 — measured at ~37 ms on this
 * machine — and pbkdf2Sync blocks the event loop for all of it. That is the
 * intended cost against an offline attacker who has stolen the database, and it
 * is NOT reduced here: the iteration count is unchanged.
 *
 * What is removed is the repetition. A stored token keeps the salt it was
 * encrypted with, so decrypting it a second time derives the exact same key
 * from the exact same inputs — the work is purely redundant. getGmailAccount()
 * decrypts two tokens per call and runs on every sync tick and every queued
 * reply, so the process was stalling ~74 ms at a time, during which no HTTP
 * request could be served.
 *
 * Caching costs nothing in security: these keys are derived from a secret that
 * already sits in this process's memory, so anyone able to read them could read
 * the secret itself. encrypt() draws a fresh random salt every time and so
 * never hits the memo — only the repeated decryption of already-stored data does.
 */
const MAX_CACHED_KEYS = 256;
const keyCache = new Map();

// Identifies the secret WITHOUT keeping it in the cache key, so a rotated
// secret can never be served a key derived from the previous one.
let cachedSecret = null;
let cachedSecretId = null;

function secretIdFor(secret) {
  if (secret !== cachedSecret) {
    cachedSecret = secret;
    cachedSecretId = crypto.createHash('sha256').update(secret).digest('base64').slice(0, 16);
    keyCache.clear();
  }
  return cachedSecretId;
}

/**
 * Derive a 256-bit key from the app secret using PBKDF2
 */
function deriveKey(salt) {
  const secret = config.encryption?.key || config.jwt.secret;
  const cacheKey = `${secretIdFor(secret)}:${salt.toString('base64')}`;

  const memoized = keyCache.get(cacheKey);
  if (memoized) {
    // Refresh recency so the hot tokens survive eviction.
    keyCache.delete(cacheKey);
    keyCache.set(cacheKey, memoized);
    return memoized;
  }

  const key = crypto.pbkdf2Sync(secret, salt, 100000, 32, 'sha512');

  if (keyCache.size >= MAX_CACHED_KEYS) {
    keyCache.delete(keyCache.keys().next().value);
  }
  keyCache.set(cacheKey, key);
  return key;
}

/**
 * Encrypt a plaintext string
 * Returns: base64(salt + iv + tag + ciphertext)
 */
function encrypt(plaintext) {
  if (!plaintext) return null;

  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  // Pack: salt(32) + iv(16) + tag(16) + ciphertext(n)
  const packed = Buffer.concat([salt, iv, tag, encrypted]);
  return packed.toString('base64');
}

/**
 * Decrypt a base64-encoded encrypted string
 */
function decrypt(encryptedBase64) {
  if (!encryptedBase64) return null;

  const packed = Buffer.from(encryptedBase64, 'base64');

  const salt = packed.subarray(0, SALT_LENGTH);
  const iv = packed.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = packed.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const ciphertext = packed.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

  const key = deriveKey(salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]);

  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };

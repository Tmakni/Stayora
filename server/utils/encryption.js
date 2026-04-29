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
 * Derive a 256-bit key from the app secret using PBKDF2
 */
function deriveKey(salt) {
  const secret = config.encryption?.key || config.jwt.secret;
  return crypto.pbkdf2Sync(secret, salt, 100000, 32, 'sha512');
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

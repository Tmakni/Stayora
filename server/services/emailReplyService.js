/**
 * Email reply service — build and send a real RFC 5322 reply to an Airbnb
 * notification, through the host's own connected Gmail account.
 *
 * Why this works at all: replying to the notification mail lands the message in
 * the right Airbnb conversation, because Airbnb puts a per-thread token address
 * in Reply-To. Verified against live mail (scripts/inspect-airbnb-headers.js):
 *
 *   From        Airbnb <express@airbnb.com>       ← NEVER reply here
 *   Reply-To    4xxxxxxxxxxxx@reply.airbnb.com    ← the routing token
 *   Message-ID  <xxx@geopod-ismtpd-NN>
 *
 * Security posture, in order of importance:
 *
 *  1. The recipient is NEVER taken from the caller. It comes from the Reply-To
 *     header of a message that this conversation actually received, read back
 *     out of the database. A compromised or buggy client cannot make this
 *     service mail an arbitrary address.
 *  2. That address must additionally sit on an allowlisted Airbnb reply domain.
 *     Both checks must pass; neither is sufficient alone.
 *  3. The token in the local part is a private per-thread identifier, so it is
 *     masked everywhere it is logged.
 *
 * Everything except sendReply() is pure, so the MIME construction and the
 * address validation are unit-testable without touching the network.
 */

const { gmail } = require('@googleapis/gmail');
const { OAuth2Client } = require('google-auth-library');
const logger = require('../utils/logger');

/**
 * Domains Airbnb routes guest replies through. Anchored: a subdomain of an
 * allowlisted domain is accepted, "reply.airbnb.com.evil.tld" is not.
 * Observed in production mail: reply.airbnb.com.
 */
const ALLOWED_REPLY_DOMAINS = [
  'reply.airbnb.com',
  'reply.airbnb.fr',
  'mail.airbnb.com',
  'express.airbnb.com',
];

/** Addresses that route nowhere useful — replying here reaches no one. */
const NON_REPLYABLE = [
  'express@airbnb.com',
  'automated@airbnb.com',
  'noreply@airbnb.com',
  'no-reply@airbnb.com',
  'discover@airbnb.com',
];

const MAX_BODY_CHARS = 8000;

// ── Address handling ────────────────────────────────────────────────────────

/** Pull the bare address out of `Name <addr@host>` or a raw address. */
function parseAddress(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const angled = raw.match(/<([^>]+)>/);
  const value = (angled ? angled[1] : raw).trim().replace(/^mailto:/i, '');
  if (!value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  return value.toLowerCase();
}

function domainOf(address) {
  const at = String(address || '').lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).toLowerCase();
}

/**
 * Mask the routing token before logging: the local part identifies a specific
 * Airbnb thread and must not sit in plaintext in logs.
 */
function maskAddress(address) {
  if (!address) return '(vide)';
  const at = String(address).lastIndexOf('@');
  if (at <= 0) return '***';
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const head = local.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(local.length - 2, 1))}@${domain}`;
}

/**
 * Is this an address we are allowed to send a guest reply to?
 * @returns {{valid: boolean, address?: string, reason?: string}}
 */
function validateReplyAddress(raw) {
  const address = parseAddress(raw);
  if (!address) return { valid: false, reason: 'adresse de réponse absente ou malformée' };

  if (NON_REPLYABLE.includes(address)) {
    return { valid: false, reason: `${maskAddress(address)} est une adresse d'envoi seul` };
  }

  const domain = domainOf(address);
  const allowed = ALLOWED_REPLY_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
  if (!allowed) {
    return { valid: false, reason: `domaine non autorisé (${domain})` };
  }

  return { valid: true, address };
}

// ── MIME ────────────────────────────────────────────────────────────────────

/** RFC 2047 encoded-word, needed for accented subjects. */
function encodeHeaderValue(value) {
  const text = String(value == null ? '' : value);
  // Strip CR/LF first: a newline in a header value is header injection.
  const safe = text.replace(/[\r\n]+/g, ' ').trim();
  if (/^[\x20-\x7E]*$/.test(safe)) return safe;
  return `=?UTF-8?B?${Buffer.from(safe, 'utf8').toString('base64')}?=`;
}

/** "Objet : …" → "Re: Objet : …", without stacking Re: on every round trip. */
function buildReplySubject(originalSubject) {
  const subject = String(originalSubject || '').replace(/[\r\n]+/g, ' ').trim();
  if (!subject) return 'Re:';
  if (/^(re|rép|rep)\s*(\[\d+\])?\s*:/i.test(subject)) return subject;
  return `Re: ${subject}`;
}

/**
 * References chain per RFC 5322 §3.6.4: existing References, then the
 * Message-ID being answered. Keeps the tail when the chain gets long, because
 * that is the part mail clients actually thread on.
 */
function buildReferences(existingReferences, inReplyTo) {
  const ids = [];
  const push = (value) => {
    for (const match of String(value || '').match(/<[^>\s]+>/g) || []) {
      if (!ids.includes(match)) ids.push(match);
    }
  };
  push(existingReferences);
  // Normalised first: a Message-ID stored without its angle brackets would
  // otherwise be silently dropped, breaking threading on the reply.
  const normalized = normalizeMessageId(inReplyTo);
  if (normalized && !ids.includes(normalized)) ids.push(normalized);
  return ids.slice(-20).join(' ');
}

/** Normalise a Message-ID to its angle-bracket form. */
function normalizeMessageId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/<[^>\s]+>/);
  if (match) return match[0];
  return /^[^\s<>]+$/.test(raw) ? `<${raw}>` : '';
}

/**
 * Wrap the body to a sane line length and quote-safe encoding.
 * Sent as base64 so accents and long lines survive intact — this avoids
 * hand-rolling quoted-printable, which is where subtle corruption creeps in.
 */
function buildMimeMessage({ from, to, subject, bodyText, inReplyTo, references }) {
  if (!to) throw new Error('MIME: destinataire manquant');
  if (!from) throw new Error('MIME: expéditeur manquant');

  const body = String(bodyText || '').slice(0, MAX_BODY_CHARS).replace(/\r\n/g, '\n').trim();
  if (!body) throw new Error('MIME: corps vide');

  const headers = [
    `From: ${encodeHeaderValue(from)}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];

  const normalizedInReplyTo = normalizeMessageId(inReplyTo);
  if (normalizedInReplyTo) headers.push(`In-Reply-To: ${normalizedInReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  // Plain text only, deliberately: the notification's HTML is Airbnb chrome,
  // and echoing it back would send the guest a copy of their own email.
  const encodedBody = Buffer.from(body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');

  return `${headers.join('\r\n')}\r\n\r\n${encodedBody}`;
}

/** Gmail's API wants base64url with no padding. */
function toBase64Url(mime) {
  return Buffer.from(mime, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ── Sending ─────────────────────────────────────────────────────────────────

/** Errors worth retrying — everything else is a permanent failure. */
function isRetryableError(err) {
  const status = err?.code || err?.status || err?.response?.status;
  if (status === 429) return true;                    // rate limited
  if (typeof status === 'number' && status >= 500) return true; // Google-side
  const message = String(err?.message || '');
  return /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|network|timeout|backendError|rateLimitExceeded|userRateLimitExceeded/i.test(message);
}

function buildGmailClient(accessToken, refreshToken) {
  const oauth2 = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oauth2.setCredentials({ access_token: accessToken, refresh_token: refreshToken });
  return gmail({ version: 'v1', auth: oauth2 });
}

/**
 * Send a reply through Gmail.
 *
 * @param {object} params
 * @param {object} params.account   decrypted gmail account (email, access_token, refresh_token)
 * @param {string} params.to        ALREADY validated recipient
 * @param {string} params.subject
 * @param {string} params.bodyText
 * @param {string} [params.inReplyTo]
 * @param {string} [params.references]
 * @param {string} [params.gmailThreadId] keeps the reply in the same Gmail thread
 * @param {boolean} [params.dryRun]  build everything, send nothing
 * @returns {Promise<{id: string, threadId: string, dryRun?: boolean}>}
 */
async function sendReply({
  account,
  to,
  subject,
  bodyText,
  inReplyTo,
  references,
  gmailThreadId,
  dryRun = false,
}) {
  // Re-validate here even though callers validate: this is the last gate before
  // a message physically leaves, and it must not depend on callers being correct.
  const check = validateReplyAddress(to);
  if (!check.valid) {
    const err = new Error(`Destinataire refusé : ${check.reason}`);
    err.permanent = true;
    throw err;
  }

  const mime = buildMimeMessage({
    from: account.email,
    to: check.address,
    subject,
    bodyText,
    inReplyTo,
    references,
  });

  if (dryRun || process.env.EMAIL_REPLY_DRY_RUN === 'true') {
    logger.info(`[dry-run] Réponse NON envoyée à ${maskAddress(check.address)} (${mime.length} octets)`);
    return { id: `dry-run-${Date.now()}`, threadId: gmailThreadId || 'dry-run', dryRun: true, mime };
  }

  const client = buildGmailClient(account.access_token, account.refresh_token);

  const requestBody = { raw: toBase64Url(mime) };
  // threadId keeps the reply attached to the same Gmail conversation. Gmail
  // rejects it if the subject does not match the thread, so it is best-effort.
  if (gmailThreadId) requestBody.threadId = gmailThreadId;

  try {
    const response = await client.users.messages.send({ userId: 'me', requestBody });
    logger.info(`Réponse envoyée à ${maskAddress(check.address)} (gmail id ${response.data.id})`);
    return { id: response.data.id, threadId: response.data.threadId };
  } catch (err) {
    // Insufficient scope is permanent until the user re-authorises.
    const text = `${err?.message || ''} ${JSON.stringify(err?.response?.data || {})}`;
    if (/insufficient|ACCESS_TOKEN_SCOPE|gmail\.send|Request had insufficient authentication scopes/i.test(text)) {
      const scopeErr = new Error('GMAIL_SEND_SCOPE_MISSING');
      scopeErr.permanent = true;
      throw scopeErr;
    }
    if (/invalid_grant|Token has been expired or revoked/i.test(text)) {
      const tokenErr = new Error('GMAIL_TOKEN_EXPIRED');
      tokenErr.permanent = true;
      throw tokenErr;
    }
    // If threadId was the problem, let the caller retry without it.
    if (/thread|Invalid threadId/i.test(text) && gmailThreadId) {
      err.retryWithoutThread = true;
    }
    err.retryable = isRetryableError(err);
    throw err;
  }
}

module.exports = {
  ALLOWED_REPLY_DOMAINS,
  NON_REPLYABLE,
  parseAddress,
  validateReplyAddress,
  maskAddress,
  encodeHeaderValue,
  buildReplySubject,
  buildReferences,
  normalizeMessageId,
  buildMimeMessage,
  toBase64Url,
  isRetryableError,
  sendReply,
};

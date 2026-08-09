/**
 * Input Sanitization Module — Defense-in-depth
 * 
 * All user input MUST pass through these functions before storage or display.
 * Parameterized queries handle SQL injection; these functions handle XSS and data integrity.
 */

// HTML entities map for XSS prevention
const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };

/**
 * Escape HTML special characters to prevent XSS when content is rendered in HTML.
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[&<>"']/g, c => HTML_ENTITIES[c]);
}

/**
 * Sanitize a general string: trim, remove null bytes, limit length.
 * Does NOT escape HTML — use escapeHtml() separately when outputting to HTML context.
 */
function sanitizeString(input, maxLength = 10000) {
  if (typeof input !== 'string') return input;

  let s = input.trim();

  // Remove null bytes (can bypass WAFs and break parsers)
  s = s.replace(/\0/g, '');

  // Remove control characters except \n \r \t
  s = s.replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Limit length
  if (s.length > maxLength) {
    s = s.substring(0, maxLength);
  }

  return s;
}

/**
 * Sanitize and validate email address.
 */
function sanitizeEmail(email) {
  if (typeof email !== 'string') return '';

  const cleaned = email.toLowerCase().trim();

  // Distinct from the format error below: an over-long address is a size
  // problem, not a syntax one, and callers (and their logs) benefit from
  // telling the two apart.
  if (cleaned.length > 255) {
    throw new Error('Email too long');
  }

  // RFC 5322 simplified — reject obvious garbage
  const emailRegex = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
  if (!emailRegex.test(cleaned)) {
    throw new Error('Invalid email format');
  }

  return cleaned;
}

/**
 * Parse and validate JSON input.
 */
function sanitizeJSON(input) {
  if (typeof input === 'string') {
    if (input.length > 1_000_000) throw new Error('JSON payload too large');
    try {
      return JSON.parse(input);
    } catch (e) {
      throw new Error('Invalid JSON format');
    }
  }
  return input;
}

/**
 * Remove <script> (and <style>) elements INCLUDING their contents.
 *
 * This is deliberately different from stripHtmlTags(): removing only the tags
 * of `<script>alert("XSS")</script>` leaves the bare payload `alert("XSS")`
 * behind as text, which is exactly the kind of residue that becomes live code
 * again the moment it is re-inserted into a template. Here the whole element is
 * dropped.
 *
 * Unterminated forms (`<script>...` with no closing tag, as produced by a
 * truncated payload) are dropped through end-of-input rather than left intact.
 */
function removeScriptTags(input) {
  if (typeof input !== 'string') return input;

  return input
    // Paired elements, tolerating attributes and whitespace in the closing tag.
    .replace(/<script\b[^>]*>[\s\S]*?<\/\s*script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/\s*style\s*>/gi, '')
    // Unterminated opener: drop the remainder rather than leaving the payload.
    .replace(/<script\b[^>]*>[\s\S]*$/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*$/gi, '')
    // Self-closing / empty forms.
    .replace(/<\s*script\b[^>]*\/?>/gi, '')
    .replace(/<\/\s*script\s*>/gi, '');
}

/**
 * Strip all HTML tags from a string.
 *
 * Script and style bodies are removed first — otherwise stripping only the
 * angle brackets would promote their contents to visible text (see
 * removeScriptTags above).
 */
function stripHtmlTags(input) {
  if (typeof input !== 'string') return input;
  return removeScriptTags(input).replace(/<[^>]*>/g, '');
}

/**
 * Validate that a value is a positive integer (for URL params like :id).
 * Returns the parsed integer or null if invalid.
 */
function validateId(value) {
  const n = parseInt(value, 10);
  if (isNaN(n) || n <= 0 || n > 2147483647 || String(n) !== String(value)) return null;
  return n;
}

/**
 * Validate a URL: must be HTTPS (or HTTP in dev), no private/internal IPs.
 * Prevents SSRF attacks via user-supplied URLs (e.g. iCal URLs).
 */
function validateExternalUrl(urlString) {
  try {
    const u = new URL(urlString);
    if (!['http:', 'https:'].includes(u.protocol)) {
      return { valid: false, reason: 'Protocol must be http or https' };
    }
    // Block private/internal IPs
    const hostname = u.hostname.toLowerCase();
    const blocked = [
      'localhost', '127.0.0.1', '0.0.0.0', '[::1]', '169.254.',
      '10.', '192.168.', 'metadata.google', 'metadata.aws',
    ];
    for (const b of blocked) {
      if (hostname === b || hostname.startsWith(b)) {
        return { valid: false, reason: 'Internal/private addresses are not allowed' };
      }
    }
    // Block 172.16.0.0/12
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) {
      return { valid: false, reason: 'Internal/private addresses are not allowed' };
    }
    return { valid: true, url: u.toString() };
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }
}

/**
 * Validate a date string (YYYY-MM-DD).
 */
function validateDateString(str) {
  if (typeof str !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(str + 'T00:00:00Z');
  return !isNaN(d.getTime());
}

module.exports = {
  sanitizeString,
  sanitizeEmail,
  sanitizeJSON,
  escapeHtml,
  stripHtmlTags,
  removeScriptTags,
  validateId,
  validateExternalUrl,
  validateDateString,
};

/**
 * Guest Name Extractor
 *
 * Airbnb notification emails all arrive from "Airbnb <express@airbnb.com>",
 * so the RFC-5322 From display name is useless as a guest name — using it as a
 * fallback is what made every row in the conversation list read "Airbnb".
 * The traveller's real first name is nonetheless present in the mail, but in
 * several different places depending on the notification template.
 *
 * This module extracts it from the mail *content*, trying every known source in
 * descending order of reliability and validating the result before accepting it.
 * Every candidate carries a confidence score so a later sync can UPGRADE a
 * previously stored weak name but never downgrade a strong one.
 *
 * Sources (highest → lowest confidence), all observed in real host mailboxes:
 *
 *   100  ROLE_BLOCK   Airbnb's message template renders as
 *                       Pour votre protection…
 *                       Florine            ← sender name
 *                       Voyageur           ← sender role
 *                       <message>
 *                     A guest-role block gives the guest name directly; a
 *                     host-role block ("Hôte", "Co-hôte") gives the HOST name,
 *                     which is recorded only so it can be excluded.
 *    90  GUEST_LABEL  "à l'attention du voyageur Gaëlle", "du voyageur (Romane)",
 *                     "Voyageur : Maxime", "Guest: John"
 *    80  SUBJECT      "Nouveau message de Jean", "New message from Jean"
 *    70  HOST_GREETING  The host's own reply opens with "Bonjour Florine," —
 *                     extremely reliable in practice, but only from an
 *                     *outgoing* message (the host addresses the guest).
 *    60  SIGNATURE    An incoming message signed on its last line ("Merci,\nFlorine")
 *
 * Everything is pure (no DB, no I/O) so it can be unit-tested directly and
 * reused by both the live sync path and the backfill migration.
 */

// Placeholder shown when no reliable name could be found — never "Airbnb".
const FALLBACK_GUEST_NAME = 'Voyageur';

const CONFIDENCE = {
  ROLE_BLOCK: 100,
  GUEST_LABEL: 90,
  SUBJECT: 80,
  HOST_GREETING: 70,
  SIGNATURE: 60,
  NONE: 0,
};

// Roles Airbnb prints under the sender's name inside the message card.
const GUEST_ROLES = ['voyageur', 'voyageuse', 'guest', 'traveler', 'traveller'];
const HOST_ROLES = [
  'hôte', 'hote', 'host', 'co-hôte', 'co-hote', 'cohôte', 'cohote', 'co-host', 'cohost',
  'superhost', 'superhôte', 'superhote', 'super-hôte', 'super-hote',
  'responsable de la réservation', 'responsable de la reservation',
];

// Civility titles to strip: "Bonjour Mme Houndji" → "Houndji".
const TITLE_RE = /^(?:m|mr|mme|mlle|monsieur|madame|mademoiselle|dr|me|sir|miss|mrs|ms)\.?\s+/i;

/**
 * Words that must never be accepted as a name. Without this the greeting and
 * signature heuristics happily return "dernière m", "oui", "to" or "lit p" —
 * exactly the junk currently sitting in the conversations table.
 */
const STOPWORDS = new Set([
  // French function words / fillers that commonly follow a greeting
  'oui', 'non', 'merci', 'je', 'tu', 'il', 'elle', 'on', 'nous', 'vous', 'ils', 'elles',
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'ce', 'cet', 'cette', 'ces',
  'mon', 'ma', 'mes', 'ton', 'ta', 'tes', 'son', 'sa', 'ses', 'notre', 'nos', 'votre', 'vos',
  'et', 'ou', 'où', 'mais', 'donc', 'car', 'ni', 'or', 'si', 'que', 'qui', 'quoi', 'dont',
  'pour', 'avec', 'sans', 'dans', 'sur', 'sous', 'par', 'chez', 'vers', 'entre', 'depuis',
  'est', 'sont', 'suis', 'es', 'ai', 'as', 'a', 'avez', 'avons', 'ont', 'sera', 'serait',
  'pas', 'plus', 'moins', 'très', 'tres', 'trop', 'bien', 'bon', 'bonne', 'tout', 'toute',
  'alors', 'aussi', 'encore', 'déjà', 'deja', 'ici', 'là', 'voilà', 'voila', 'comme',
  'bonjour', 'bonsoir', 'salut', 'coucou', 'cordialement', 'salutations', 'bienvenue',
  // Interjections: "Bonjour ah j arrive" must not yield "Ah"
  'ah', 'oh', 'eh', 'hé', 'he', 'bah', 'ben', 'hein', 'euh', 'hum', 'hmm', 'aie', 'aïe',
  'ouf', 'oups', 'hop', 'ola', 'olà', 'aha', 'wow', 'yep', 'yeah', 'nope', 'huh', 'oops',
  'désolé', 'desole', 'désolée', 'desolee', 'pardon', 'parfait', 'super', 'génial', 'genial',
  'effectivement', 'exactement', 'normalement', 'evidemment', 'évidemment',
  'dernière', 'derniere', 'dernier', 'prochaine', 'prochain', 'nouvelle', 'nouveau',
  // Domain words that leak out of Airbnb templates and message bodies
  'airbnb', 'booking', 'message', 'messages', 'réservation', 'reservation', 'réservations',
  'logement', 'logements', 'annonce', 'annonces', 'séjour', 'sejour', 'arrivée', 'arrivee',
  'départ', 'depart', 'voyageur', 'voyageurs', 'voyageuse', 'hôte', 'hote', 'host', 'guest',
  // Sender-role labels: a role line must never be mistaken for the name above it
  'co-hôte', 'co-hote', 'cohôte', 'cohote', 'co-host', 'cohost', 'superhôte', 'superhote',
  'super-hôte', 'super-hote', 'responsable', 'traveler', 'traveller', 'hôtes', 'hotes',
  'superhost', 'consulter', 'répondre', 'repondre', 'afficher', 'image', 'envoyée', 'envoyee',
  'équipe', 'equipe', 'support', 'service', 'assistance', 'notification', 'notifications',
  'lit', 'lits', 'chambre', 'chambres', 'piscine', 'jacuzzi', 'spa', 'wifi', 'code', 'adresse',
  'clé', 'cle', 'clés', 'cles', 'ménage', 'menage', 'caution', 'facture', 'paiement',
  // English fillers
  'yes', 'no', 'thanks', 'thank', 'the', 'an', 'i', 'you', 'we', 'they', 'he', 'she', 'it',
  'is', 'are', 'am', 'was', 'were', 'be', 'been', 'to', 'of', 'in', 'on', 'at', 'for', 'and',
  'or', 'but', 'so', 'hello', 'hi', 'hey', 'there', 'all', 'good', 'great', 'ok', 'okay',
  'sure', 'please', 'sorry', 'regards', 'best', 'cheers', 'welcome',
  // Months (dates follow "pour"/"de" in many subjects)
  'janvier', 'février', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'aout',
  'septembre', 'octobre', 'novembre', 'décembre', 'decembre',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  // Weekdays
  'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

// Connector words allowed *inside* a multi-part name: "Roxana Et Frédéric",
// "Amance et Sylvie", "Jean-Marc and Julie".
const NAME_CONNECTORS = new Set(['et', 'and', '&', '+']);

const LETTERS = 'A-Za-zÀ-ÖØ-öø-ÿ';
// A single name token: starts with a letter, may contain hyphens/apostrophes.
const NAME_TOKEN_RE = new RegExp(`^[${LETTERS}][${LETTERS}'’\\-]*$`);
// Reusable capture group for a name inside larger patterns.
const NAME_CAPTURE = `([${LETTERS}][${LETTERS}'’\\-]*(?:\\s+(?:et|and|&)\\s+[${LETTERS}][${LETTERS}'’\\-]*|\\s+[${LETTERS}][${LETTERS}'’\\-]*){0,2})`;

/**
 * Title-case a token, preserving internal hyphens/apostrophes:
 * "DELPHINE" → "Delphine", "jean-marc" → "Jean-Marc".
 */
function titleCaseToken(token) {
  return token
    .split(/([-'’])/)
    .map((part) => (/[-'’]/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()))
    .join('');
}

/**
 * Normalise a raw candidate to a displayable name, or return null if it is not
 * a plausible human name. This is the single gate every source goes through.
 */
function normalizeName(raw) {
  if (!raw || typeof raw !== 'string') return null;

  let value = raw
    .replace(/[​-‍﻿]/g, '')  // zero-width junk from HTML mails
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'«»(\[]+|[\s"'«»)\].,;:!?]+$/g, '')
    .trim();

  value = value.replace(TITLE_RE, '').trim();

  if (!value) return null;
  if (value.length < 2 || value.length > 40) return null;
  if (/\d/.test(value)) return null;                 // never a name: "2 mai", "Villa 3"
  if (/[@/\\|<>{}$%*=_]/.test(value)) return null;   // emails, URLs, template vars

  const tokens = value.split(' ').filter(Boolean);
  if (tokens.length === 0 || tokens.length > 4) return null;

  const kept = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (NAME_CONNECTORS.has(lower)) {
      // A connector is only meaningful between two name parts.
      if (kept.length === 0) return null;
      kept.push(lower === '&' || lower === '+' ? 'et' : lower);
      continue;
    }
    if (!NAME_TOKEN_RE.test(token)) return null;
    if (STOPWORDS.has(lower)) return null;
    if (token.replace(/[-'’]/g, '').length < 2) return null;  // "c", "m", "s"
    kept.push(titleCaseToken(token));
  }

  // A trailing connector means we cut mid-phrase ("Amance et") — not a name.
  if (kept.length === 0 || NAME_CONNECTORS.has(kept[kept.length - 1].toLowerCase())) return null;

  const result = kept.join(' ');
  // Require at least one real name part of 2+ characters.
  if (!kept.some((t) => !NAME_CONNECTORS.has(t.toLowerCase()) && t.length >= 2)) return null;

  return result;
}

/**
 * Normalise a regex capture that may have over-matched.
 *
 * NAME_CAPTURE is greedy and most label patterns have no closing anchor, so
 * "du voyageur Gaëlle a été envoyé" captures "Gaëlle a été". Retrying with one
 * fewer trailing token until the value validates recovers the real name instead
 * of discarding the match outright.
 */
function normalizeNameCapture(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  for (let take = Math.min(tokens.length, 4); take >= 1; take--) {
    const candidate = normalizeName(tokens.slice(0, take).join(' '));
    if (candidate) return candidate;
  }
  return null;
}

/** Case/accent-insensitive key used to compare names (host exclusion, dedupe). */
function nameKey(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]/g, '')
    .trim();
}

/**
 * Find every "<name>\n<role>" block in an Airbnb message body.
 * Returns { guestNames: string[], hostNames: string[] } — host names are
 * collected purely so they can be excluded from guest candidates.
 */
function extractRoleBlocks(body) {
  const guestNames = [];
  const hostNames = [];
  if (!body) return { guestNames, hostNames };

  const lines = body.split('\n').map((l) => l.trim());

  for (let i = 1; i < lines.length; i++) {
    const roleLine = lines[i].toLowerCase().replace(/[.,:;]+$/, '').trim();
    if (!roleLine) continue;

    const isGuestRole = GUEST_ROLES.includes(roleLine);
    const isHostRole = HOST_ROLES.includes(roleLine);
    if (!isGuestRole && !isHostRole) continue;

    // Walk back over blank lines to the name line above the role.
    let j = i - 1;
    while (j >= 0 && lines[j] === '') j--;
    if (j < 0) continue;

    const candidate = normalizeName(lines[j]);
    if (!candidate) continue;

    if (isGuestRole) guestNames.push(candidate);
    else hostNames.push(candidate);
  }

  return { guestNames, hostNames };
}

/** Explicit "voyageur X" / "guest X" labels used by Airbnb's system mails. */
const GUEST_LABEL_PATTERNS = [
  // "Le message … à l'attention du voyageur (Skogran) a été ignoré"
  new RegExp(`(?:à\\s+l['’]attention\\s+)?d[ue]\\s+voyageur\\s*\\(\\s*${NAME_CAPTURE}\\s*\\)`, 'i'),
  new RegExp(`(?:à\\s+l['’]attention\\s+)?d[ue]\\s+voyageur\\s+${NAME_CAPTURE}`, 'i'),
  new RegExp(`\\bvoyageur\\s*[:\\-–]\\s*${NAME_CAPTURE}`, 'i'),
  new RegExp(`\\bguest\\s*[:\\-–]\\s*${NAME_CAPTURE}`, 'i'),
  new RegExp(`\\bto\\s+guest\\s*\\(?\\s*${NAME_CAPTURE}`, 'i'),
  new RegExp(`\\bréserv[ée]\\s+par\\s+${NAME_CAPTURE}`, 'i'),
  new RegExp(`\\bbooked\\s+by\\s+${NAME_CAPTURE}`, 'i'),
];

/** Subject-line templates that name the guest. */
const SUBJECT_PATTERNS = [
  new RegExp(`(?:nouveau|nouvelle)\\s+(?:message|demande[^\\n]*?)\\s+de\\s+${NAME_CAPTURE}`, 'i'),
  new RegExp(`^${NAME_CAPTURE}\\s+vous\\s+a\\s+envoy`, 'i'),
  new RegExp(`new\\s+message\\s+from\\s+${NAME_CAPTURE}`, 'i'),
  new RegExp(`(?:reservation|booking|inquiry)\\s+(?:request\\s+)?from\\s+${NAME_CAPTURE}`, 'i'),
  new RegExp(`(?:demande\\s+de\\s+r[ée]servation|demande\\s+de\\s+renseignement)\\s+de\\s+${NAME_CAPTURE}`, 'i'),
  new RegExp(`^${NAME_CAPTURE}\\s+(?:a\\s+fait|souhaite|demande\\b)`, 'i'),
];

/** Greeting openers the host uses when replying to the guest. */
const GREETING_PATTERNS = [
  new RegExp(`^\\s*(?:bonjour|bonsoir|salut|coucou|hello|hi|hey|dear|cher|chère|chere)\\s+${NAME_CAPTURE}\\s*[,!.\\n]`, 'i'),
];

/**
 * Pull a guest-name candidate out of a single email.
 *
 * @param {object} input
 * @param {string} [input.subject]
 * @param {string} [input.body]       decoded plain-text body (post stripHtml)
 * @param {'incoming'|'outgoing'} [input.role]
 * @param {Set<string>} [input.excludedKeys]  nameKey()s that must not be returned (host names)
 * @returns {{name: string, source: string, confidence: number}|null}
 */
function extractFromEmail({ subject = '', body = '', role = 'incoming', excludedKeys } = {}) {
  const excluded = excludedKeys || new Set();
  const isExcluded = (name) => excluded.has(nameKey(name));

  // 1. Airbnb role block — the guest's own name as Airbnb renders it.
  const { guestNames } = extractRoleBlocks(body);
  for (const name of guestNames) {
    if (!isExcluded(name)) {
      return { name, source: 'role_block', confidence: CONFIDENCE.ROLE_BLOCK };
    }
  }

  // 2. Explicit "voyageur X" labels in system notifications.
  for (const pattern of GUEST_LABEL_PATTERNS) {
    const match = body.match(pattern) || subject.match(pattern);
    if (!match) continue;
    const name = normalizeNameCapture(match[1]);
    if (name && !isExcluded(name)) {
      return { name, source: 'guest_label', confidence: CONFIDENCE.GUEST_LABEL };
    }
  }

  // 3. Subject templates that carry the guest's name.
  for (const pattern of SUBJECT_PATTERNS) {
    const match = subject.match(pattern);
    if (!match) continue;
    const name = normalizeNameCapture(match[1]);
    if (name && !isExcluded(name)) {
      return { name, source: 'subject', confidence: CONFIDENCE.SUBJECT };
    }
  }

  // 4. Host's greeting — only in a message the host sent ("Bonjour Florine,").
  if (role === 'outgoing') {
    for (const pattern of GREETING_PATTERNS) {
      const match = body.match(pattern);
      if (!match) continue;
      const name = normalizeNameCapture(match[1]);
      if (name && !isExcluded(name)) {
        return { name, source: 'host_greeting', confidence: CONFIDENCE.HOST_GREETING };
      }
    }
  }

  // 5. Guest's own signature — last meaningful line of an incoming message.
  if (role === 'incoming') {
    const name = extractSignature(body, excluded);
    if (name) return { name, source: 'signature', confidence: CONFIDENCE.SIGNATURE };
  }

  return null;
}

/**
 * A guest often signs off on the final line:
 *   "Merci ,\n   Florine"
 * Only the last few lines are inspected, and each must pass normalizeName().
 */
function extractSignature(body, excluded) {
  if (!body) return null;
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // Scan the last 3 lines, closest first.
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
    const line = lines[i].replace(/^[-–—*\s]+/, '').trim();
    // A signature is short; a sentence is not.
    if (line.split(/\s+/).length > 3) continue;
    const name = normalizeName(line);
    if (name && !excluded.has(nameKey(name))) return name;
  }
  return null;
}

/**
 * Resolve the guest name for a whole Gmail thread.
 *
 * Host names found anywhere in the thread are collected FIRST and excluded from
 * every candidate, so a co-host signing "DELPHINE / Co-hôte" can never become
 * the guest name. Candidates are then ranked by confidence, and ties are broken
 * by order of appearance (earliest message wins — that is the thread opener).
 *
 * @param {Array<{subject?: string, body?: string, role?: string}>} emails
 *        Thread messages in chronological order.
 * @param {object} [options]
 * @param {string[]} [options.knownHostNames] extra names to exclude (e.g. account owner)
 * @returns {{name: string, source: string, confidence: number}}
 *          `name` is FALLBACK_GUEST_NAME with confidence 0 when nothing reliable was found.
 */
function extractGuestNameFromThread(emails, options = {}) {
  const list = Array.isArray(emails) ? emails : [];

  // Pass 1 — collect host names across the whole thread.
  const excludedKeys = new Set();
  for (const name of options.knownHostNames || []) {
    const normalized = normalizeName(name);
    if (normalized) excludedKeys.add(nameKey(normalized));
  }
  excludedKeys.add(nameKey('Airbnb'));
  for (const email of list) {
    const { hostNames } = extractRoleBlocks(email.body || '');
    for (const name of hostNames) excludedKeys.add(nameKey(name));
  }

  // Pass 2 — best candidate across the thread.
  let best = null;
  for (const email of list) {
    const candidate = extractFromEmail({
      subject: email.subject || '',
      body: email.body || '',
      role: email.role === 'outgoing' ? 'outgoing' : 'incoming',
      excludedKeys,
    });
    if (!candidate) continue;
    if (!best || candidate.confidence > best.confidence) best = candidate;
  }

  return best || { name: FALLBACK_GUEST_NAME, source: 'fallback', confidence: CONFIDENCE.NONE };
}

/**
 * Should a freshly extracted name replace what is already stored?
 *
 * Strictly monotonic in confidence so repeated syncs cannot flip a conversation
 * back and forth between two travellers. Legacy junk ("Airbnb", "Voyageur",
 * empty) is always replaceable by any real candidate.
 */
function shouldReplaceStoredName(storedName, storedConfidence, candidate) {
  if (!candidate || !candidate.name || candidate.confidence <= CONFIDENCE.NONE) return false;
  if (!storedName) return true;

  const storedKey = nameKey(storedName);
  const isPlaceholder =
    storedKey === '' || storedKey === 'airbnb' || storedKey === nameKey(FALLBACK_GUEST_NAME);
  if (isPlaceholder) return true;

  // A stored name that never passed validation (legacy rows like "dernière m").
  if (!normalizeName(storedName)) return true;

  if (storedKey === nameKey(candidate.name)) return false;

  return candidate.confidence > (storedConfidence || 0);
}

module.exports = {
  FALLBACK_GUEST_NAME,
  CONFIDENCE,
  extractGuestNameFromThread,
  extractFromEmail,
  extractRoleBlocks,
  normalizeName,
  nameKey,
  shouldReplaceStoredName,
};

/**
 * Airbnb listing resolver — URL safety + real listing title extraction
 *
 * Two jobs, both previously handled ad-hoc inside airbnbImportController:
 *
 * 1. TITLE. Imports were saving names like "Logement Airbnb #11739290151".
 *    That placeholder was baked into parseListing() as a `||` fallback and then
 *    returned unchecked by the __NEXT_DATA__ branch, so a page that parsed but
 *    carried no name shipped the placeholder straight into the database. The
 *    meta-tag branch could do worse: it fell back to `og:site_name`, which on
 *    every Airbnb page is the literal string "Airbnb".
 *    Here the title is resolved from ordered, independently-validated sources —
 *    JSON-LD → Open Graph → <title> → data already parsed by the caller — and
 *    a value that is empty, an id, or an Airbnb boilerplate string is REJECTED
 *    rather than stored.
 *
 * 2. SSRF. These URLs come from user input and are fetched server-side.
 *    Requests are pinned to a strict Airbnb host allowlist, redirects are
 *    followed manually with every hop re-validated (so an open redirect cannot
 *    walk us onto an internal address), and every response is bounded by both a
 *    timeout and a byte cap.
 *
 * Pure/​IO split is deliberate: everything except safeFetch/resolveShortLink is
 * synchronous and side-effect free so it can be unit-tested without a network.
 */

const logger = require('../utils/logger');
const { validateExternalUrl } = require('../utils/sanitize');

// ── Limits ──────────────────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS = 12000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // Airbnb PDP HTML is ~1-2 MB
const MAX_REDIRECT_HOPS = 5;

/**
 * Airbnb's public domains. Matches airbnb.<tld> and any subdomain of it
 * (www., fr., m., etc.). Anchored at both ends so "airbnb.com.evil.tld" and
 * "notairbnb.com" are rejected.
 */
const AIRBNB_HOST_RE = /^(?:[a-z0-9-]+\.)*airbnb\.(?:[a-z]{2,3})(?:\.[a-z]{2})?$/i;

/** Short-link / deep-link hosts Airbnb uses in emails and the mobile app. */
const AIRBNB_SHORT_HOSTS = new Set([
  'abnb.me',
  'airbnb.app.link',
  'a.airbnb.com',
]);

function isAirbnbHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return AIRBNB_HOST_RE.test(host) || AIRBNB_SHORT_HOSTS.has(host);
}

/**
 * Validate a URL for server-side fetching: well-formed, https/http, an Airbnb
 * host, and not pointing at a private/internal address.
 * Returns { valid, url } or { valid: false, reason }.
 */
function validateAirbnbUrl(input) {
  let candidate = String(input || '').trim();
  if (!candidate) return { valid: false, reason: 'URL vide' };
  if (!/^https?:\/\//i.test(candidate)) candidate = 'https://' + candidate;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { valid: false, reason: "Format d'URL invalide" };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, reason: 'Le protocole doit être http ou https' };
  }
  if (!isAirbnbHost(parsed.hostname)) {
    return { valid: false, reason: 'Seuls les liens Airbnb sont acceptés' };
  }

  // Reuse the shared private-IP/metadata blocklist as defence in depth: the
  // host allowlist above is the primary control, this catches the case where an
  // Airbnb-looking host resolves somewhere it should not.
  const generic = validateExternalUrl(parsed.toString());
  if (!generic.valid) return { valid: false, reason: generic.reason };

  return { valid: true, url: parsed.toString() };
}

/**
 * Normalise une adresse de profil hôte Airbnb.
 *
 * Airbnb sert DEUX formes pour la même page, et l'adresse que l'hôte copie
 * depuis son navigateur traîne en plus des paramètres de suivi :
 *
 *   https://www.airbnb.fr/users/profile/1462634058239796981?previous_page_name=…
 *   https://www.airbnb.fr/users/show/1462634058239796981
 *   1462634058239796981
 *
 * Seule /users/show/ était reconnue, et les paramètres n'étaient pas retirés.
 * L'IDENTIFIANT est la référence : tout le reste se reconstruit à partir de lui,
 * ce qui rend l'entrée insensible au domaine régional, à la casse et au suivi.
 *
 * @returns {{valid: boolean, id?: string, urls?: string[], reason?: string}}
 */
function normalizeProfileUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return { valid: false, reason: 'Adresse vide' };

  // Identifiant seul.
  if (/^\d{4,25}$/.test(raw)) return { valid: true, id: raw, urls: profileUrlsFor(raw) };

  let candidate = raw;
  if (!/^https?:\/\//i.test(candidate)) candidate = 'https://' + candidate;

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { valid: false, reason: "Format d'adresse invalide" };
  }

  if (!isAirbnbHost(parsed.hostname)) {
    return { valid: false, reason: 'Seules les adresses Airbnb sont acceptées' };
  }

  const match = parsed.pathname.match(/\/users\/(?:profile|show)\/(\d{4,25})/i);
  if (!match) {
    return {
      valid: false,
      reason: "Cette adresse n'est pas celle d'un profil hôte (attendu /users/profile/… ou /users/show/…)",
    };
  }

  // Les paramètres sont abandonnés en reconstruisant l'adresse depuis
  // l'identifiant seul : `previous_page_name`, `source_impression_id` et
  // consorts n'apportent rien et suivent la navigation de l'hôte.
  return { valid: true, id: match[1], urls: profileUrlsFor(match[1]) };
}

/**
 * Les deux formes canoniques à essayer, dans l'ordre. Selon la région et la
 * langue, Airbnb rend l'une ou l'autre.
 */
function profileUrlsFor(id) {
  return [
    `https://www.airbnb.fr/users/profile/${id}`,
    `https://www.airbnb.com/users/show/${id}`,
  ];
}

/**
 * Fetch with a timeout, a hard byte cap, and manually-validated redirects.
 *
 * `redirect: 'manual'` matters: with 'follow', a single open redirect on an
 * allowlisted host would carry the request to an arbitrary destination without
 * the allowlist ever being consulted again.
 *
 * Returns { ok, status, body, finalUrl } — body is '' when not ok.
 */
async function safeFetch(startUrl, { timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES, headers = {} } = {}) {
  let currentUrl = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const check = validateAirbnbUrl(currentUrl);
    if (!check.valid) return { ok: false, status: 0, body: '', finalUrl: currentUrl, reason: check.reason };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch(check.url, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
          ...headers,
        },
      });
    } catch (err) {
      clearTimeout(timer);
      return { ok: false, status: 0, body: '', finalUrl: currentUrl, reason: err.name === 'AbortError' ? 'timeout' : err.message };
    }

    // Redirect: validate the next hop before following it.
    if (response.status >= 300 && response.status < 400) {
      clearTimeout(timer);
      const location = response.headers.get('location');
      if (!location) return { ok: false, status: response.status, body: '', finalUrl: currentUrl, reason: 'redirect sans Location' };
      try {
        currentUrl = new URL(location, check.url).toString();
      } catch {
        return { ok: false, status: response.status, body: '', finalUrl: currentUrl, reason: 'redirect invalide' };
      }
      continue;
    }

    if (!response.ok) {
      clearTimeout(timer);
      return { ok: false, status: response.status, body: '', finalUrl: check.url, reason: `HTTP ${response.status}` };
    }

    // Enforce the byte cap while streaming, so an oversized (or endless)
    // response can never be buffered whole. Content-Length is only a hint —
    // it is absent on chunked responses and can lie — so the running total is
    // what actually stops the read.
    const declared = parseInt(response.headers.get('content-length') || '0', 10);
    if (declared && declared > maxBytes) {
      clearTimeout(timer);
      try { await response.body?.cancel(); } catch (_) {}
      return { ok: false, status: response.status, body: '', finalUrl: check.url, reason: 'réponse trop volumineuse' };
    }

    try {
      const body = await readCapped(response, maxBytes);
      clearTimeout(timer);
      return { ok: true, status: response.status, body, finalUrl: check.url };
    } catch (err) {
      clearTimeout(timer);
      return { ok: false, status: response.status, body: '', finalUrl: check.url, reason: err.message };
    }
  }

  return { ok: false, status: 0, body: '', finalUrl: currentUrl, reason: 'trop de redirections' };
}

async function readCapped(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    // Undici always streams, but stay defensive for mocked responses in tests.
    const text = await response.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let received = 0;
  let out = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      out += decoder.decode(value, { stream: false });
      try { await reader.cancel(); } catch (_) {}
      break;
    }
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

// ── Listing id ──────────────────────────────────────────────────────────────

/**
 * Extract the numeric listing id from any Airbnb URL shape, or from a bare id.
 * Returns null when there is nothing id-shaped (e.g. an unresolved short link).
 */
function extractListingId(input) {
  if (!input) return null;
  const raw = String(input).trim();

  if (/^\d{4,}$/.test(raw)) return raw;

  const patterns = [
    /\/rooms?\/(?:plus\/|luxury\/)?(\d{4,})/i,  // /rooms/123, /rooms/plus/123
    /[?&]listing_?id=(\d{4,})/i,
    /\/h\/[^/?#]*?[-/](\d{6,})(?:[/?#]|$)/i,
  ];
  for (const re of patterns) {
    const m = raw.match(re);
    if (m) return m[1];
  }
  return null;
}

/**
 * Resolve a short link (abnb.me/…, airbnb.app.link/…) to its final Airbnb URL
 * so a listing id can be pulled out of it. Network call; returns null on failure.
 */
async function resolveShortLink(url) {
  const result = await safeFetch(url, { timeoutMs: 8000, maxBytes: 512 * 1024 });
  if (!result.ok) return null;

  const fromFinalUrl = extractListingId(result.finalUrl);
  if (fromFinalUrl) return { listingId: fromFinalUrl, finalUrl: result.finalUrl };

  // App-link interstitials carry the destination in the body instead.
  const fromBody = extractListingId(result.body.slice(0, 200000));
  if (fromBody) return { listingId: fromBody, finalUrl: result.finalUrl };

  return null;
}

// ── Title extraction ────────────────────────────────────────────────────────

/**
 * Boilerplate Airbnb appends to page titles, in the locales this app serves.
 * Stripped from the END of a candidate only, so a listing genuinely called
 * "Airbnb Loft" keeps its name.
 */
const TITLE_SUFFIXES = [
  /\s*[-–—|·]\s*airbnb\s*$/i,
  /\s*[-–—|·]\s*location\s+de\s+vacances.*$/i,
  /\s*[-–—|·]\s*vacation\s+rental.*$/i,
];

/**
 * Airbnb's <title> is a catalogue string:
 *   "La Villa Cosy - Proche Bordeaux - Maisons à louer à Ambarès, France - Airbnb"
 * Everything from the catalogue segment onwards is descriptive chrome, not part
 * of the listing name.
 */
const CATALOGUE_SEGMENT = [
  /\s[-–—]\s(?:[^-–—]*\s)?(?:à louer|a louer)\s+à\s.*$/i,
  /\s[-–—]\s(?:[^-–—]*\s)?for\s+rent\s+in\s.*$/i,
  /\s[-–—]\s(?:maisons?|appartements?|villas?|chalets?|studios?|logements?|condos?|houses?|apartments?|lofts?)\s+(?:à|a|in|en)\s.*$/i,
];

/** Strings that are Airbnb chrome rather than a listing name. */
const BOILERPLATE_NAMES = new Set([
  'airbnb', 'airbnb.com', 'airbnb.fr', 'www.airbnb.com',
  'vacation rentals', 'location de vacances', 'locations de vacances',
  'holiday rentals', 'logement', 'logements', 'listing', 'annonce',
]);

/**
 * Titres de pages qui ne sont PAS une annonce.
 *
 * Airbnb ne répond pas toujours par la fiche demandée. Selon la région, la
 * langue ou le soupçon de robot, il renvoie une page intermédiaire — une
 * redirection vers le domaine local, un mur anti-robot, une page d'erreur —
 * qui possède un `<title>` parfaitement lisible et totalement faux. C'est
 * ainsi que des logements se sont retrouvés nommés
 *
 *     « Redirection vers fr.airbnb.com »
 *
 * La liste ci-dessus ne les attrapait pas : elle compare des chaînes ENTIÈRES,
 * et celle-ci n'y figure pas. Les motifs ci-dessous jugent la FORME du titre,
 * ce qui couvre aussi les variantes de langue et de domaine.
 *
 * Le principe : mieux vaut ne pas avoir de nom et le demander à l'hôte que d'en
 * inscrire un faux. Un nom faux ne se voit pas — il ressemble à un vrai nom
 * dans la liste des logements — et c'est celui que Michel citera au voyageur.
 */
const INVALID_NAME_PATTERNS = [
  // Un vrai nom d'annonce ne contient pas le domaine d'Airbnb. C'est le motif
  // qui attrape « Redirection vers fr.airbnb.com » quelle que soit sa langue.
  /(?:^|[\s/@.])(?:[a-z0-9-]+\.)*airbnb\.[a-z]{2,3}(?:\.[a-z]{2})?(?:$|[\s/:,])/i,
  // Titre d'accueil générique d'Airbnb. C'est ce que renvoie une page de profil
  // récupérée côté serveur : « Airbnb : locations de vacances, cabanes… ».
  // Une annonce ne s'appelle pas « Airbnb » suivi de deux points.
  /^\s*airbnb\s*[:：|·–—-]/i,
  // Pages de redirection, dans les langues qu'Airbnb sert à cette application.
  /\bredirection\b/i,
  /\bredirecting\b/i,
  /\bredirig\w*\b/i,
  /\bvous allez être redirigé\b/i,
  // Murs anti-robot et pages d'attente.
  /^\s*(?:just a moment|un instant|attention required)/i,
  /\bchecking your browser\b/i,
  /\bv[ée]rification (?:de|du) (?:votre )?navigateur\b/i,
  /\b(?:activez|enable) (?:le )?javascript\b/i,
  /\baccess (?:to this page )?denied\b/i,
  /acc[èe]s\s+refus/i,
  // Pages d'erreur.
  /\bpage (?:introuvable|non trouv[ée]e|indisponible)\b/i,
  /\b(?:page )?not found\b/i,
  /\b(?:oops|something went wrong|une erreur est survenue)\b/i,
  /^\s*(?:erreur|error)\s*\d*\s*$/i,
  /^\s*\d{3}\s*[-–—|]?\s*(?:error|erreur)?\s*$/i,
];

/** Le titre se réduit-il à un nom de domaine ou une URL ? */
const DOMAIN_ONLY = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?$/i;

/**
 * Normalise a raw title candidate into a listing name, or return null.
 */
function cleanListingTitle(raw) {
  if (!raw || typeof raw !== 'string') return null;

  let value = raw
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    })
    .replace(/\s+/g, ' ')
    .trim();

  for (const re of CATALOGUE_SEGMENT) value = value.replace(re, '').trim();
  // Suffixes are applied repeatedly: "… - Location de vacances - Airbnb".
  for (let pass = 0; pass < 3; pass++) {
    let before = value;
    for (const re of TITLE_SUFFIXES) value = value.replace(re, '').trim();
    if (value === before) break;
  }

  value = value.replace(/^[\s"'«»|·–—-]+|[\s"'«»|·–—-]+$/g, '').trim();
  return value || null;
}

/**
 * Is this a name we must never persist?
 * Covers the placeholder the old code generated, bare ids, Airbnb chrome, and
 * anything without a single letter in it.
 */
function isPlaceholderName(name, listingId) {
  if (!name || typeof name !== 'string') return true;

  const value = name.trim();
  if (value.length < 3 || value.length > 200) return true;
  if (!/[a-zA-ZÀ-ÖØ-öø-ÿ]/.test(value)) return true;              // no letters at all
  if (/^\d+$/.test(value)) return true;                            // bare id
  if (BOILERPLATE_NAMES.has(value.toLowerCase())) return true;
  if (/^logement(\s+airbnb)?\s*#?\s*\d+$/i.test(value)) return true;
  if (/^(?:listing|annonce|property)\s*#?\s*\d+$/i.test(value)) return true;
  if (listingId && value.includes(String(listingId))) return true; // id leaked into the name
  if (DOMAIN_ONLY.test(value)) return true;                        // « fr.airbnb.com »
  for (const re of INVALID_NAME_PATTERNS) {                        // redirection, mur anti-robot, erreur
    if (re.test(value)) return true;
  }

  return false;
}

/**
 * La page reçue est-elle une page intermédiaire plutôt que la fiche demandée ?
 *
 * Sert à ne PAS lire le `<title>` d'une page qui n'est pas l'annonce. Le titre
 * d'une redirection est bien formé et passerait sans cela pour un nom, faute de
 * JSON-LD et d'Open Graph sur ces pages pour le devancer.
 *
 * Ne juge que des signaux structurels : une redirection déclarée dans l'en-tête,
 * ou une page si courte qu'elle ne peut pas contenir une fiche.
 */
function looksLikeInterstitial(html) {
  if (typeof html !== 'string' || html.trim() === '') return true;

  // <meta http-equiv="refresh" content="0; url=…"> : la page dit elle-même
  // qu'elle n'est qu'un relais.
  if (/<meta[^>]+http-equiv=["']?refresh["']?[^>]*>/i.test(html)) return true;

  const title = titleFromPageTitle(html);
  if (title && isPlaceholderName(title, null)) return true;

  return false;
}

/** Convenience: a name that is safe to store. */
function isValidListingName(name, listingId) {
  return !isPlaceholderName(name, listingId);
}

// ── HTML source extractors ──────────────────────────────────────────────────

function titleFromJsonLd(html) {
  const blocks = Array.from(
    html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi),
    (m) => m[1]
  );

  for (const block of blocks) {
    let data;
    try {
      data = JSON.parse(block.trim());
    } catch {
      continue;
    }
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const candidate = item.name || item.headline || item.title;
      const cleaned = cleanListingTitle(candidate);
      if (cleaned) return cleaned;
    }
  }
  return null;
}

function titleFromOpenGraph(html) {
  // og:title only — og:site_name is always the literal "Airbnb", which is how
  // the old meta fallback produced listings named "Airbnb".
  const patterns = [
    /<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i,
    /<meta[^>]*content=["']([^"']*)["'][^>]*property=["']og:title["']/i,
    /<meta[^>]*name=["']twitter:title["'][^>]*content=["']([^"']*)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const cleaned = cleanListingTitle(m[1]);
      if (cleaned) return cleaned;
    }
  }
  return null;
}

function titleFromPageTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  return cleanListingTitle(m[1]);
}

/**
 * Resolve the listing's real title from every available source, in descending
 * order of reliability, keeping the first that passes validation.
 *
 * @param {object} input
 * @param {string} [input.html]            fetched listing page
 * @param {string} [input.listingId]
 * @param {string} [input.parsedName]      name already produced by the existing analysis
 * @param {string} [input.scanName]        name seen on the host's profile scan
 * @returns {{name: string|null, source: string}}
 */
function resolveListingTitle({ html = '', listingId = null, parsedName = null, scanName = null } = {}) {
  // Une page intermédiaire — redirection, mur anti-robot, erreur — n'a rien à
  // dire sur cette annonce. On l'écarte AVANT toute lecture plutôt que de
  // compter sur la validation pour rattraper chaque titre qu'elle peut porter.
  const usableHtml = html && !looksLikeInterstitial(html) ? html : '';

  const attempts = [
    ['json_ld', () => (usableHtml ? titleFromJsonLd(usableHtml) : null)],
    ['open_graph', () => (usableHtml ? titleFromOpenGraph(usableHtml) : null)],
    ['page_title', () => (usableHtml ? titleFromPageTitle(usableHtml) : null)],
    ['parsed_data', () => cleanListingTitle(parsedName)],
    ['profile_scan', () => cleanListingTitle(scanName)],
  ];

  for (const [source, run] of attempts) {
    let candidate = null;
    try {
      candidate = run();
    } catch (err) {
      logger.warn(`resolveListingTitle: source ${source} failed: ${err.message}`);
    }
    if (candidate && isValidListingName(candidate, listingId)) {
      return { name: candidate, source };
    }
  }

  return { name: null, source: 'none' };
}

module.exports = {
  // URL safety
  isAirbnbHost,
  validateAirbnbUrl,
  normalizeProfileUrl,
  profileUrlsFor,
  safeFetch,
  extractListingId,
  resolveShortLink,
  // Title
  cleanListingTitle,
  isPlaceholderName,
  isValidListingName,
  looksLikeInterstitial,
  resolveListingTitle,
  titleFromJsonLd,
  titleFromOpenGraph,
  titleFromPageTitle,
  // Constants (tests / callers)
  FETCH_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  MAX_REDIRECT_HOPS,
};

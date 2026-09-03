/**
 * Lecture des annonces d'un profil hôte Airbnb, avec un vrai navigateur.
 *
 * POURQUOI CE FICHIER EXISTE
 * --------------------------
 * Airbnb ne livre plus les annonces d'un hôte dans le HTML de sa page de
 * profil. Mesuré sur une page réelle depuis ce projet :
 *
 *   requête HTTP simple  → 350 ko de coquille, 0 annonce
 *   navigateur réel      → 10 annonces, avec leurs vrais titres, en ~10 s
 *
 * La page arrive vide et se remplit ensuite en JavaScript. Aucun perfectionnement
 * de l'analyse HTML ne pouvait donc y changer quoi que ce soit : il n'y a rien à
 * analyser. Il faut exécuter la page.
 *
 * POURQUOI PUPPETEER ET PAS PLAYWRIGHT
 * ------------------------------------
 * L'image de ce serveur est bâtie sur node:20-alpine, donc sur musl. Playwright
 * ne supporte pas Alpine : les navigateurs qu'il télécharge sont compilés pour
 * glibc. L'adopter imposait de changer l'image de base pour Debian et d'ajouter
 * ~400 Mo. `puppeteer-core` était déjà présent dans le dépôt, ne télécharge
 * aucun navigateur, et se contente du Chromium du système — celui du paquet
 * `chromium` d'Alpine, ajouté au Dockerfile.
 *
 * CE QUE CE MODULE GARANTIT
 * -------------------------
 *   - il est OPTIONNEL : sans binaire de navigateur, il rend `available: false`
 *     et l'appelant retombe sur l'ancienne méthode, puis sur l'export ;
 *   - UN SEUL navigateur à la fois (verrou), parce qu'un Chromium consomme
 *     autant que le reste de l'application et que l'hébergement est petit ;
 *   - tout est borné : délai de navigation, nombre de défilements, durée totale,
 *     nombre d'annonces ;
 *   - le navigateur est TOUJOURS fermé, y compris en cas d'erreur ;
 *   - il ne contourne aucune protection : pas de résolution de CAPTCHA, pas de
 *     rotation d'adresse, pas de session authentifiée. Si Airbnb présente un mur,
 *     on s'arrête et on le dit.
 *
 * Aucune donnée n'est écrite ici : ce module LIT et rend une liste. La décision
 * d'importer reste à l'hôte, écran suivant.
 */

const logger = require('../utils/logger');
const { isPlaceholderName } = require('./airbnbListingResolver');

// ── Bornes ──────────────────────────────────────────────────────────────────
const NAV_TIMEOUT_MS = 30000;
const TOTAL_BUDGET_MS = 60000;
const MAX_SCROLLS = 12;
const SCROLL_PAUSE_MS = 900;
const MAX_LISTINGS = 60;

/** Emplacements habituels d'un Chromium, du conteneur au poste de travail. */
const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/chromium-browser',        // Alpine (paquet `chromium`)
  '/usr/bin/chromium',                // Debian/Ubuntu
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

/**
 * Le pilotage par navigateur est-il utilisable ici ?
 *
 * Désactivable par AIRBNB_BROWSER_SCAN=false : sur un hébergement trop juste en
 * mémoire, mieux vaut refuser franchement que de se faire tuer en plein scan.
 */
function browserScanAvailable() {
  if (String(process.env.AIRBNB_BROWSER_SCAN || '').toLowerCase() === 'false') {
    return { available: false, reason: 'disabled' };
  }

  let puppeteer;
  try {
    puppeteer = require('puppeteer-core');
  } catch (_) {
    return { available: false, reason: 'puppeteer_absent' };
  }

  const executablePath = findBrowser();
  if (!executablePath) return { available: false, reason: 'browser_not_found' };

  return { available: true, executablePath, puppeteer };
}

function findBrowser() {
  const fs = require('fs');
  for (const candidate of BROWSER_CANDIDATES) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) {
      // Chemin illisible : on passe au suivant.
    }
  }
  return null;
}

// ── Verrou ──────────────────────────────────────────────────────────────────
//
// Deux scans simultanés, c'est deux Chromium, et l'instance n'a pas la mémoire
// pour cela. Le second attendrait sans rien apporter : on le refuse tout de
// suite, avec un motif que l'écran sait expliquer.
let scanInFlight = false;

/**
 * Extrait, dans la page déjà rendue, une annonce par carte.
 *
 * Cette fonction est SÉRIALISÉE puis exécutée dans le navigateur : elle ne peut
 * rien référencer de ce fichier.
 *
 * La carte d'une annonce est le plus grand ancêtre du lien qui ne contient
 * qu'UN seul lien d'annonce. Repère vérifié sur une page réelle : remonter plus
 * haut ramène le conteneur commun à toutes les cartes, et le même texte
 * ressortait alors pour chacune.
 *
 * Le titre est la ligne qui n'est ni le type de logement, ni une note, ni un
 * décompte d'évaluations. Sur la page mesurée, les cartes se lisent :
 *   ["Logement entier", "La Villa Cosy - Proche Bordeaux", "Évaluation de …", …]
 */
/* istanbul ignore next — s'exécute dans le navigateur, pas sous Jest */
function extractCardsInPage() {
  const NOISE = [
    /^logement entier$/i,
    /^chambre/i,
    /^logement/i,
    /^[éе]valuation/i,
    /^nouveau$/i,
    /^\d+([.,]\d+)?$/,
    /^[,·•\s]+$/,
    /^·?\s*\d+\s*[ée]valuations?$/i,
    /^superh[oô]te$/i,
    /^coup de c(?:œ|oe)ur/i,
  ];

  const isNoise = (line) => NOISE.some((re) => re.test(line));

  const byId = new Map();
  for (const anchor of document.querySelectorAll('a[href*="/rooms/"]')) {
    const href = anchor.getAttribute('href') || '';
    const match = href.match(/\/rooms\/(\d{6,})/);
    if (!match) continue;
    const id = match[1];
    if (byId.has(id)) continue;

    let node = anchor;
    let card = anchor;
    for (let up = 0; up < 8 && node && node.parentElement; up++) {
      node = node.parentElement;
      if (node.querySelectorAll('a[href*="/rooms/"]').length !== 1) break;
      card = node;
    }

    const lines = (card.innerText || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    const title = lines.find((line) => line.length >= 3 && !isNoise(line)) || null;

    byId.set(id, { id, title, href: href.split('?')[0] });
  }
  return [...byId.values()];
}

/**
 * Lit les annonces d'un profil hôte.
 *
 * @param {string[]} profileUrls formes canoniques à essayer, dans l'ordre
 * @returns {Promise<{ok: boolean, listings?: Array, reason?: string, detail?: string}>}
 *
 * Motifs d'échec, tous destinés à être expliqués à l'hôte :
 *   unavailable   — pas de navigateur installé/activé ici
 *   busy          — un autre scan est déjà en cours
 *   blocked       — Airbnb présente un mur anti-robot ou une vérification
 *   timeout       — la page n'a pas fini de se charger dans le budget
 *   no_listings   — la page s'est chargée mais ne montre aucune annonce
 *   error         — panne inattendue
 */
async function scanProfileWithBrowser(profileUrls) {
  const capability = browserScanAvailable();
  if (!capability.available) {
    return { ok: false, reason: 'unavailable', detail: capability.reason };
  }
  if (scanInFlight) {
    return { ok: false, reason: 'busy' };
  }

  scanInFlight = true;
  const startedAt = Date.now();
  let browser = null;

  try {
    browser = await capability.puppeteer.launch({
      executablePath: capability.executablePath,
      headless: 'new',
      args: [
        // Indispensables en conteneur : pas de bac à sable utilisateur, et
        // /dev/shm y est trop petit pour Chromium, qui se met alors à planter
        // au milieu du rendu.
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--lang=fr-FR',
      ],
    });

    for (const url of profileUrls) {
      if (Date.now() - startedAt > TOTAL_BUDGET_MS) break;

      const attempt = await scanOnePage(browser, url, startedAt);
      if (attempt.ok && attempt.listings.length > 0) return attempt;
      // Un mur anti-robot ne se contourne pas en réessayant l'autre domaine :
      // on remonte tout de suite pour que l'écran bascule sur l'export.
      if (attempt.reason === 'blocked') return attempt;
    }

    return { ok: false, reason: 'no_listings' };
  } catch (err) {
    logger.warn(`Scan navigateur du profil Airbnb: ${err.message}`);
    const timedOut = /timeout|TimeoutError/i.test(err.message);
    return { ok: false, reason: timedOut ? 'timeout' : 'error', detail: err.message };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        logger.warn(`Fermeture du navigateur impossible: ${closeErr.message}`);
      }
    }
    scanInFlight = false;
  }
}

async function scanOnePage(browser, url, startedAt) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 900 });
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    const title = (await page.title()) || '';
    if (/captcha|attention required|just a moment|v[ée]rification/i.test(title)) {
      logger.info(`Scan navigateur: Airbnb présente une vérification sur ${url}`);
      return { ok: false, reason: 'blocked', detail: title.slice(0, 120) };
    }

    // Défilement : Airbnb charge les cartes au fur et à mesure. On s'arrête dès
    // que le compte cesse d'augmenter — inutile de dérouler une page finie.
    let previous = 0;
    for (let i = 0; i < MAX_SCROLLS; i++) {
      if (Date.now() - startedAt > TOTAL_BUDGET_MS) break;

      const count = await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight * 1.5);
        return document.querySelectorAll('a[href*="/rooms/"]').length;
      });
      await new Promise((resolve) => setTimeout(resolve, SCROLL_PAUSE_MS));

      if (count > 0 && count === previous) break;
      previous = count;
    }

    const raw = await page.evaluate(extractCardsInPage);

    // Le titre passe la MÊME validation que partout ailleurs. Une annonce dont
    // le titre est refusé repart sans nom plutôt qu'avec un faux : l'écran la
    // présente décochée, et l'import la refuserait de toute façon.
    const listings = raw.slice(0, MAX_LISTINGS).map((card) => {
      const name = card.title && isPlaceholderName(card.title, card.id) ? null : card.title || null;
      return {
        id: card.id,
        name,
        url: `https://www.airbnb.fr/rooms/${card.id}`,
        needs_name: !name,
      };
    });

    return { ok: true, listings, source: 'browser' };
  } finally {
    try {
      await page.close();
    } catch (_) {
      // La page part avec le navigateur de toute façon.
    }
  }
}

module.exports = {
  browserScanAvailable,
  scanProfileWithBrowser,
  extractCardsInPage,
  MAX_LISTINGS,
};

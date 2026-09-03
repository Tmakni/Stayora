/**
 * Airbnb listing resolver — unit tests
 *
 * Covers the two defects this module was written for:
 *   1. imports saved as "Logement Airbnb #11739290151" (or literally "Airbnb")
 *      instead of the listing's real title;
 *   2. user-supplied URLs fetched server-side with no host allowlist, no
 *      redirect re-validation, and no size cap.
 *
 * Fixtures mirror the real markup of an Airbnb room page, including the
 * catalogue-style <title> and the og:site_name trap.
 */

const {
  isAirbnbHost,
  validateAirbnbUrl,
  extractListingId,
  cleanListingTitle,
  isPlaceholderName,
  isValidListingName,
  resolveListingTitle,
  titleFromJsonLd,
  titleFromOpenGraph,
  titleFromPageTitle,
} = require('../services/airbnbListingResolver');

const LISTING_ID = '11739290151';

const FULL_PAGE = `<!doctype html><html><head>
<title>La Villa Cosy - Proche Bordeaux - Maisons à louer à Ambarès-et-Lagrave, Nouvelle-Aquitaine, France - Airbnb</title>
<meta property="og:site_name" content="Airbnb"/>
<meta property="og:title" content="La Villa Cosy - Proche Bordeaux - Maisons à louer à Ambarès-et-Lagrave, France"/>
<script type="application/ld+json">{"@type":"LodgingBusiness","name":"La Villa Cosy - Proche Bordeaux"}</script>
</head><body></body></html>`;

describe('isAirbnbHost', () => {
  it('accepts Airbnb domains, subdomains and short links', () => {
    for (const host of ['airbnb.com', 'www.airbnb.com', 'fr.airbnb.com', 'airbnb.fr',
      'airbnb.co.uk', 'm.airbnb.com', 'abnb.me', 'airbnb.app.link']) {
      expect(isAirbnbHost(host)).toBe(true);
    }
  });

  it('rejects look-alike and internal hosts', () => {
    // airbnb.com.evil.tld is the classic suffix-confusion payload.
    for (const host of ['airbnb.com.evil.tld', 'notairbnb.com', 'evil-airbnb.com.attacker.net',
      'localhost', '127.0.0.1', '169.254.169.254', 'metadata.google.internal', 'evil.com', '']) {
      expect(isAirbnbHost(host)).toBe(false);
    }
  });
});

describe('validateAirbnbUrl (SSRF surface)', () => {
  it('accepts a normal listing URL', () => {
    expect(validateAirbnbUrl('https://www.airbnb.fr/rooms/12345678').valid).toBe(true);
  });

  it('rejects non-Airbnb hosts, internal targets and non-http schemes', () => {
    for (const url of [
      'http://localhost:3000/rooms/1',
      'http://127.0.0.1/rooms/1',
      'http://169.254.169.254/latest/meta-data/',
      'https://evil.com/rooms/1',
      'https://airbnb.com.attacker.net/rooms/1',
      'file:///etc/passwd',
      'ftp://airbnb.com/x',
      '',
    ]) {
      expect(validateAirbnbUrl(url).valid).toBe(false);
    }
  });
});

describe('extractListingId', () => {
  it('handles every URL shape and bare ids', () => {
    expect(extractListingId('https://www.airbnb.fr/rooms/11739290151?check_in=x')).toBe('11739290151');
    expect(extractListingId('https://airbnb.com/rooms/plus/998877')).toBe('998877');
    expect(extractListingId('https://www.airbnb.com/rooms/luxury/445566')).toBe('445566');
    expect(extractListingId('https://www.airbnb.fr/h/villa-cosy-123456789')).toBe('123456789');
    expect(extractListingId('11739290151')).toBe('11739290151');
  });

  it('returns null when there is no id (e.g. an unresolved short link)', () => {
    expect(extractListingId('https://abnb.me/xYz9')).toBeNull();
    expect(extractListingId('not a url')).toBeNull();
    expect(extractListingId('')).toBeNull();
    expect(extractListingId(null)).toBeNull();
  });
});

describe('cleanListingTitle', () => {
  it('strips the Airbnb catalogue suffix but keeps hyphens inside the name', () => {
    expect(
      cleanListingTitle('La Villa Cosy - Proche Bordeaux - Maisons à louer à Ambarès, France - Airbnb')
    ).toBe('La Villa Cosy - Proche Bordeaux');

    expect(cleanListingTitle('Le Cocon Terracotta - Spa - Airbnb')).toBe('Le Cocon Terracotta - Spa');
    expect(cleanListingTitle('Green love & Spa | Airbnb')).toBe('Green love & Spa');
  });

  it('decodes HTML entities', () => {
    expect(cleanListingTitle('Green love &amp; Spa')).toBe('Green love & Spa');
    expect(cleanListingTitle('L&#39;Escale')).toBe("L'Escale");
  });

  it('keeps a genuine name that merely contains the word Airbnb', () => {
    expect(cleanListingTitle('Airbnb Loft Central')).toBe('Airbnb Loft Central');
  });

  it('returns null for empty input', () => {
    expect(cleanListingTitle('')).toBeNull();
    expect(cleanListingTitle(null)).toBeNull();
    expect(cleanListingTitle('   ')).toBeNull();
  });
});

describe('isPlaceholderName', () => {
  it('rejects the generated placeholders that were reaching the database', () => {
    for (const bad of [
      'Logement Airbnb #11739290151',
      'Logement #123',
      'logement airbnb #999',
      '11739290151',
      'Airbnb',
      'airbnb.com',
      '',
      '   ',
      'A',
      '—',
      '123456',
    ]) {
      expect(isPlaceholderName(bad, LISTING_ID)).toBe(true);
    }
  });

  it('rejects any name that leaks the listing id', () => {
    expect(isPlaceholderName(`Villa ${LISTING_ID}`, LISTING_ID)).toBe(true);
  });

  it('accepts real listing names', () => {
    for (const good of [
      'La Villa Cosy - Proche Bordeaux',
      'Le Cocon Terracotta - Spa',
      "L'Escale",
      'Green love & Spa - Villa Romantique',
      'Studio 12 rue des Lilas',
    ]) {
      expect(isPlaceholderName(good, LISTING_ID)).toBe(false);
      expect(isValidListingName(good, LISTING_ID)).toBe(true);
    }
  });
});

describe('individual HTML sources', () => {
  it('reads JSON-LD, Open Graph and <title>', () => {
    expect(titleFromJsonLd(FULL_PAGE)).toBe('La Villa Cosy - Proche Bordeaux');
    expect(titleFromOpenGraph(FULL_PAGE)).toBe('La Villa Cosy - Proche Bordeaux');
    expect(titleFromPageTitle(FULL_PAGE)).toBe('La Villa Cosy - Proche Bordeaux');
  });

  it('never returns og:site_name, which is always the literal "Airbnb"', () => {
    const siteNameOnly = '<html><head><meta property="og:site_name" content="Airbnb"/></head></html>';
    expect(titleFromOpenGraph(siteNameOnly)).toBeNull();
  });
});

describe('resolveListingTitle — ordered fallbacks', () => {
  it('prefers JSON-LD', () => {
    expect(resolveListingTitle({ html: FULL_PAGE, listingId: LISTING_ID }))
      .toEqual({ name: 'La Villa Cosy - Proche Bordeaux', source: 'json_ld' });
  });

  it('falls back to Open Graph, then <title>', () => {
    const noJsonLd = FULL_PAGE.replace(/<script[\s\S]*?<\/script>/, '');
    expect(resolveListingTitle({ html: noJsonLd, listingId: LISTING_ID }).source).toBe('open_graph');

    const titleOnly = '<html><head><title>Le Cocon Terracotta - Spa - Airbnb</title></head></html>';
    expect(resolveListingTitle({ html: titleOnly, listingId: LISTING_ID }))
      .toEqual({ name: 'Le Cocon Terracotta - Spa', source: 'page_title' });
  });

  it('falls back to data the existing analysis already produced', () => {
    const chrome = '<html><head><title>Airbnb</title></head></html>';
    expect(resolveListingTitle({ html: chrome, listingId: LISTING_ID, parsedName: 'La Planquette - Piscine' }))
      .toEqual({ name: 'La Planquette - Piscine', source: 'parsed_data' });
  });

  it('falls back to the profile-scan name last', () => {
    expect(resolveListingTitle({
      html: '',
      listingId: LISTING_ID,
      parsedName: `Logement Airbnb #${LISTING_ID}`,
      scanName: 'Green love & Spa',
    })).toEqual({ name: 'Green love & Spa', source: 'profile_scan' });
  });

  it('returns null rather than a placeholder when every source is chrome', () => {
    const chrome = '<html><head><title>Airbnb</title><meta property="og:site_name" content="Airbnb"/></head></html>';
    const result = resolveListingTitle({
      html: chrome,
      listingId: LISTING_ID,
      parsedName: `Logement Airbnb #${LISTING_ID}`,
    });
    expect(result.name).toBeNull();
    expect(result.source).toBe('none');
  });

  it('never propagates a name containing the listing id', () => {
    const result = resolveListingTitle({ html: '', listingId: LISTING_ID, parsedName: `Villa ${LISTING_ID}` });
    expect(result.name).toBeNull();
  });

  it('survives malformed JSON-LD without throwing', () => {
    const broken = '<html><head><script type="application/ld+json">{not json,,}</script>'
      + '<title>Villa Bleue - Airbnb</title></head></html>';
    expect(resolveListingTitle({ html: broken, listingId: LISTING_ID }).name).toBe('Villa Bleue');
  });

  it('handles empty input without throwing', () => {
    expect(resolveListingTitle({}).name).toBeNull();
    expect(resolveListingTitle().name).toBeNull();
  });
});

/**
 * Titres qu'Airbnb sert À LA PLACE d'une fiche.
 *
 * Constatés en interrogeant réellement Airbnb depuis ce projet : une page de
 * profil renvoie le titre d'accueil générique, une annonce inexistante renvoie
 * « 404 Page Not Found - Airbnb », et selon la région une page de redirection
 * s'intercale, titrée « Redirection vers fr.airbnb.com ». Aucun de ces titres
 * n'était rejeté : ils s'inscrivaient comme nom de logement, où ils passent
 * pour de vrais noms — et c'est ce nom que Michel cite ensuite au voyageur.
 */
describe('titres de pages intermédiaires Airbnb', () => {
  const { looksLikeInterstitial } = require('../services/airbnbListingResolver');

  const rejected = [
    'Redirection vers fr.airbnb.com',
    'Redirecting to airbnb.com',
    '404 Page Not Found - Airbnb',
    'Page introuvable',
    'Page not found',
    'Just a moment...',
    'Attention Required! | Cloudflare',
    'Checking your browser before accessing airbnb.com',
    'Airbnb : locations de vacances, cabanes, maisons de plage, logements et expériences uniques',
    'fr.airbnb.com',
    'www.airbnb.fr',
    'https://www.airbnb.fr/rooms/12345678',
    'Accès refusé',
  ];

  for (const bad of rejected) {
    it(`refuse « ${bad} »`, () => {
      expect(isPlaceholderName(bad, LISTING_ID)).toBe(true);
    });
  }

  // Le sens inverse compte autant : un filtre trop large renverrait l'hôte
  // saisir à la main des noms parfaitement récupérables.
  const accepted = [
    'Green Love & Spa - Villa Romantique',
    'Le Cocon Terracotta',
    'La Villa Rivière & Spa',
    'La Planquette',
    'La Villa Cosy - Proche Bordeaux',
    'Airbnb Loft in Brooklyn',
    'Studio 404 rue de la Paix',
  ];

  for (const good of accepted) {
    it(`accepte « ${good} »`, () => {
      expect(isPlaceholderName(good, LISTING_ID)).toBe(false);
    });
  }

  it("écarte une page qui se déclare elle-même comme un relais", () => {
    expect(looksLikeInterstitial('<html><head><meta http-equiv="refresh" content="0; url=https://fr.airbnb.com/"></head><body>x</body></html>'.padEnd(300, ' '))).toBe(true);
  });

  it("écarte une page dont le titre est une erreur", () => {
    const page = `<html><head><title>404 Page Not Found - Airbnb</title></head><body>${'x'.repeat(300)}</body></html>`;
    expect(looksLikeInterstitial(page)).toBe(true);
  });

  it('garde une vraie fiche', () => {
    expect(looksLikeInterstitial(FULL_PAGE.padEnd(400, ' '))).toBe(false);
  });

  it("ne tire aucun nom d'une page de redirection", () => {
    const page = `<html><head><title>Redirection vers fr.airbnb.com</title></head><body>${'x'.repeat(300)}</body></html>`;
    expect(resolveListingTitle({ html: page, listingId: LISTING_ID }).name).toBeNull();
  });
});

/**
 * Lecture d'un profil hôte Airbnb : normalisation de l'adresse, et garde-fous
 * du pilotage par navigateur.
 *
 * CONTEXTE
 * --------
 * Airbnb ne livre plus les annonces d'un hôte dans le HTML de son profil.
 * Mesuré sur une page réelle depuis ce projet : requête HTTP simple = 0 annonce,
 * navigateur réel = 10 annonces avec leurs vrais titres. Le scan passe donc
 * désormais par un navigateur, avec repli sur l'ancienne requête puis sur
 * l'export de données.
 *
 * Ce qui est couvert ici est ce qui peut l'être sans réseau ni navigateur :
 * la normalisation de l'adresse, et le fait que le module se déclare
 * INDISPONIBLE plutôt que de planter quand aucun navigateur n'est là. Le
 * pilotage lui-même est vérifié contre Airbnb, pas en test unitaire — le
 * simuler ne prouverait rien de ce qui casse réellement.
 */

const { normalizeProfileUrl } = require('../services/airbnbListingResolver');

const PROFILE_ID = '1462634058239796981';

describe("normalisation de l'adresse de profil", () => {
  it('accepte la forme /users/profile/ et retire les paramètres de suivi', () => {
    const r = normalizeProfileUrl(
      `https://www.airbnb.fr/users/profile/${PROFILE_ID}?previous_page_name=host_profile&s=42`
    );
    expect(r.valid).toBe(true);
    expect(r.id).toBe(PROFILE_ID);
    // Les adresses sont RECONSTRUITES depuis l'identifiant : aucun paramètre ne
    // peut donc survivre, quel qu'il soit.
    for (const url of r.urls) expect(url).not.toContain('previous_page_name');
  });

  it('accepte la forme historique /users/show/', () => {
    const r = normalizeProfileUrl(`https://www.airbnb.com/users/show/${PROFILE_ID}`);
    expect(r.valid).toBe(true);
    expect(r.id).toBe(PROFILE_ID);
  });

  it("accepte l'identifiant seul", () => {
    const r = normalizeProfileUrl(PROFILE_ID);
    expect(r.valid).toBe(true);
    expect(r.id).toBe(PROFILE_ID);
  });

  it('accepte une adresse sans protocole', () => {
    const r = normalizeProfileUrl(`www.airbnb.fr/users/profile/${PROFILE_ID}`);
    expect(r.valid).toBe(true);
    expect(r.id).toBe(PROFILE_ID);
  });

  it('propose les deux formes canoniques à essayer', () => {
    const r = normalizeProfileUrl(PROFILE_ID);
    expect(r.urls).toHaveLength(2);
    expect(r.urls.some((u) => u.includes('/users/profile/'))).toBe(true);
    expect(r.urls.some((u) => u.includes('/users/show/'))).toBe(true);
  });

  it("refuse une adresse qui n'est pas un profil", () => {
    expect(normalizeProfileUrl('https://www.airbnb.fr/rooms/12345678').valid).toBe(false);
  });

  it("refuse un hôte qui n'est pas Airbnb", () => {
    // Le scan ouvre réellement cette page dans un navigateur : laisser passer
    // un domaine arbitraire ferait de cet endpoint authentifié un mandataire.
    for (const bad of [
      `https://evil.com/users/profile/${PROFILE_ID}`,
      `https://airbnb.com.evil.tld/users/profile/${PROFILE_ID}`,
      `https://notairbnb.com/users/show/${PROFILE_ID}`,
    ]) {
      expect(normalizeProfileUrl(bad).valid).toBe(false);
    }
  });

  it('refuse une entrée vide ou informe', () => {
    for (const bad of ['', '   ', null, undefined, 'bonjour']) {
      expect(normalizeProfileUrl(bad).valid).toBe(false);
    }
  });
});

describe('disponibilité du pilotage par navigateur', () => {
  const ORIGINAL = process.env.AIRBNB_BROWSER_SCAN;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.AIRBNB_BROWSER_SCAN;
    else process.env.AIRBNB_BROWSER_SCAN = ORIGINAL;
    jest.resetModules();
  });

  it('se déclare indisponible quand la variable le désactive', () => {
    process.env.AIRBNB_BROWSER_SCAN = 'false';
    jest.resetModules();
    const { browserScanAvailable } = require('../services/airbnbProfileBrowser');

    const verdict = browserScanAvailable();
    expect(verdict.available).toBe(false);
    expect(verdict.reason).toBe('disabled');
  });

  it('rend un verdict au lieu de lever, quel que soit l\'environnement', () => {
    // Le point important : sur un hébergement sans navigateur, l'appelant doit
    // pouvoir retomber sur la requête HTTP puis sur l'export. Une exception ici
    // ferait échouer tout le scan au lieu de le dégrader.
    delete process.env.AIRBNB_BROWSER_SCAN;
    jest.resetModules();
    const { browserScanAvailable } = require('../services/airbnbProfileBrowser');

    const verdict = browserScanAvailable();
    expect(typeof verdict.available).toBe('boolean');
    if (!verdict.available) {
      expect(['disabled', 'puppeteer_absent', 'browser_not_found']).toContain(verdict.reason);
    }
  });

  it('refuse un second scan simultané plutôt que de lancer deux navigateurs', async () => {
    // Un Chromium consomme autant que le reste de l'application. Deux scans en
    // parallèle, c'est l'instance tuée pour dépassement mémoire.
    process.env.AIRBNB_BROWSER_SCAN = 'false';
    jest.resetModules();
    const { scanProfileWithBrowser } = require('../services/airbnbProfileBrowser');

    const result = await scanProfileWithBrowser([`https://www.airbnb.fr/users/profile/${PROFILE_ID}`]);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unavailable');
  });
});

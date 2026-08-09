/**
 * Guest name extraction — unit tests
 *
 * Covers the bug that made every row of the conversation list read "Airbnb":
 * Airbnb notifications all come from "Airbnb <express@airbnb.com>", so the From
 * display name is never the traveller's, and the old loose regexes produced
 * junk ("dernière m", "lit p", "to") when they matched at all.
 *
 * Fixtures below are shaped after real mails from a production host mailbox
 * (subjects like "Objet : Réservation pour <logement>, 4–7 mai" carry no name;
 * the name lives in the body).
 */

const {
  FALLBACK_GUEST_NAME,
  CONFIDENCE,
  extractGuestNameFromThread,
  extractFromEmail,
  extractRoleBlocks,
  normalizeName,
  nameKey,
  shouldReplaceStoredName,
} = require('../services/guestNameExtractor');

describe('normalizeName', () => {
  it('accepts ordinary first names and title-cases them', () => {
    expect(normalizeName('Florine')).toBe('Florine');
    expect(normalizeName('  DELPHINE ')).toBe('Delphine');
    expect(normalizeName('jean-marc')).toBe('Jean-Marc');
    expect(normalizeName("O'Brien")).toBe("O'Brien");
    expect(normalizeName('Gaëlle')).toBe('Gaëlle');
  });

  it('keeps two-person bookings joined by a connector', () => {
    expect(normalizeName('Roxana Et Frédéric')).toBe('Roxana et Frédéric');
    expect(normalizeName('Amance et Sylvie')).toBe('Amance et Sylvie');
  });

  it('strips civility titles', () => {
    expect(normalizeName('Mme Houndji')).toBe('Houndji');
    expect(normalizeName('M. Dupont')).toBe('Dupont');
  });

  it('rejects the junk the old extractor produced', () => {
    // These are verbatim values found in the conversations table.
    for (const junk of ['dernière m', 'lit p', 'votre s', 'to', 'c', 'm']) {
      expect(normalizeName(junk)).toBeNull();
    }
  });

  it('rejects filler words, dates, emails and template noise', () => {
    for (const bad of [
      'oui', 'merci', 'bonjour', 'Airbnb', 'Voyageur', 'Hôte', 'Co-hôte',
      '4 mai', 'Villa 3', 'contact@airbnb.com', '%opentrack%',
      'https://airbnb.fr/x', '', '   ', null, undefined, 42,
    ]) {
      expect(normalizeName(bad)).toBeNull();
    }
  });

  it('rejects an over-long phrase rather than storing a sentence as a name', () => {
    expect(normalizeName('je voudrais savoir si on doit eteindre le jacuzzi')).toBeNull();
  });
});

describe('nameKey', () => {
  it('is case- and accent-insensitive so the same person compares equal', () => {
    expect(nameKey('Frédéric')).toBe(nameKey('FREDERIC'));
    expect(nameKey('Gaëlle')).toBe('gaelle');
  });

  it('separates genuinely different names', () => {
    expect(nameKey('Marie')).not.toBe(nameKey('Marion'));
  });
});

describe('extractRoleBlocks', () => {
  it('reads the traveller name from Airbnb\'s "name / role" card', () => {
    const body = [
      'Pour votre protection et votre sécurité, communiquez toujours via Airbnb.',
      'Florine',
      'Voyageur',
      'Bonsoir, je voudrais savoir si on doit éteindre le jacuzzi ?',
    ].join('\n');

    const { guestNames, hostNames } = extractRoleBlocks(body);
    expect(guestNames).toEqual(['Florine']);
    expect(hostNames).toEqual([]);
  });

  it('classifies a host/co-host card as HOST, never as guest', () => {
    const body = 'Ah oui pardon le jeudi 2 avril\n\nDELPHINE\n\nCo-hôte\n\nVous recevrez les indications';
    const { guestNames, hostNames } = extractRoleBlocks(body);
    expect(guestNames).toEqual([]);
    expect(hostNames).toEqual(['Delphine']);
  });
});

describe('extractFromEmail — per-source behaviour', () => {
  it('reads "à l\'attention du voyageur X" from system notifications', () => {
    const withParens = extractFromEmail({
      body: 'Le message « rappel 2 jours avant l\'arrivée » à l\'attention du voyageur (Skogran) a été ignoré',
    });
    expect(withParens).toMatchObject({ name: 'Skogran', source: 'guest_label' });

    const withoutParens = extractFromEmail({
      body: 'Le message « procédure de départ » à l\'attention du voyageur Gaëlle a été envoyé à une date autre',
    });
    expect(withoutParens).toMatchObject({ name: 'Gaëlle', source: 'guest_label' });
  });

  it('reads the name from a subject template when there is one', () => {
    expect(extractFromEmail({ subject: 'Nouveau message de Jean Dupont' }))
      .toMatchObject({ name: 'Jean Dupont', source: 'subject' });
    expect(extractFromEmail({ subject: 'New message from Sarah' }))
      .toMatchObject({ name: 'Sarah', source: 'subject' });
  });

  it('reads the host\'s greeting, but only from an outgoing message', () => {
    const body = 'Bonjour Skogran,\n   merci d\'avoir choisi La Villa Rivière & SPA pour votre séjour';

    expect(extractFromEmail({ body, role: 'outgoing' }))
      .toMatchObject({ name: 'Skogran', source: 'host_greeting' });

    // The same text incoming is the GUEST addressing the HOST — using it would
    // store the host's name as the traveller's.
    expect(extractFromEmail({ body, role: 'incoming' })).toBeNull();
  });

  it('does not mistake a greeting followed by ordinary words for a name', () => {
    expect(extractFromEmail({ body: 'Bonjour c zst disponible\n', role: 'outgoing' })).toBeNull();
    expect(extractFromEmail({ body: 'Bonjour oui tout a fait\n', role: 'outgoing' })).toBeNull();
    expect(extractFromEmail({ body: 'Bonjour ah j arrive\n', role: 'outgoing' })).toBeNull();
  });

  it('reads a traveller signature from an incoming message', () => {
    const body = 'Bonsoir ,\n je voudrais savoir si on doit éteindre le jacuzzi.\n\n Merci ,\n Florine';
    expect(extractFromEmail({ body, role: 'incoming' }))
      .toMatchObject({ name: 'Florine', source: 'signature' });
  });

  it('honours the exclusion set', () => {
    const body = 'Bonjour Delphine,\n j\'ai une question';
    const excluded = new Set([nameKey('Delphine')]);
    expect(extractFromEmail({ body, role: 'outgoing', excludedKeys: excluded })).toBeNull();
  });

  it('returns null on a subject that carries only the property and dates', () => {
    expect(extractFromEmail({
      subject: 'Objet : Réservation pour La Villa Cosy - Proche Bordeaux, 4–7 mai',
      body: 'Consulter la réservation',
    })).toBeNull();
  });
});

describe('extractGuestNameFromThread', () => {
  it('prefers the highest-confidence source available in the thread', () => {
    const result = extractGuestNameFromThread([
      { role: 'outgoing', body: 'Bonjour Charlotte,\n merci' },
      { role: 'incoming', body: 'Pour votre protection\nCharlotte Martin\nVoyageur\nmerci !' },
    ]);
    expect(result.name).toBe('Charlotte Martin');
    expect(result.confidence).toBe(CONFIDENCE.ROLE_BLOCK);
  });

  it('never returns the host\'s name, even when a guest greets them by it', () => {
    // Real failure mode: the guest writes "Bonjour Delphine," and the message
    // was stored with the wrong role, so a greeting rule would yield the HOST.
    const result = extractGuestNameFromThread(
      [{ role: 'outgoing', body: 'Bonjour Delphine,\n J\'aurai une petite question' }],
      { knownHostNames: ['Delphine'] }
    );
    expect(result.name).toBe(FALLBACK_GUEST_NAME);
  });

  it('excludes a host discovered from a role card elsewhere in the same thread', () => {
    const result = extractGuestNameFromThread([
      { role: 'outgoing', body: 'Je précise :)\n\nDELPHINE\n\nCo-hôte\n' },
      { role: 'outgoing', body: 'Bonjour Delphine,\n une question' },
      { role: 'outgoing', body: 'Bonjour Nadine,\n je vous rappelle l\'adresse' },
    ]);
    expect(result.name).toBe('Nadine');
  });

  it('falls back to "Voyageur" — never to "Airbnb" — when nothing is reliable', () => {
    const result = extractGuestNameFromThread([
      {
        subject: 'Objet : Réservation pour La Villa Cosy - Proche Bordeaux, 4–7 mai',
        body: 'Consulter la réservation\nRépondre',
      },
    ]);
    expect(result.name).toBe(FALLBACK_GUEST_NAME);
    expect(result.name).not.toBe('Airbnb');
    expect(result.confidence).toBe(CONFIDENCE.NONE);
  });

  it('never returns "Airbnb" even if the mail says so', () => {
    const result = extractGuestNameFromThread([
      { role: 'incoming', body: 'Pour votre protection\nAirbnb\nVoyageur\nmessage' },
    ]);
    expect(result.name).not.toBe('Airbnb');
  });

  it('handles empty / malformed input without throwing', () => {
    expect(extractGuestNameFromThread([]).name).toBe(FALLBACK_GUEST_NAME);
    expect(extractGuestNameFromThread(null).name).toBe(FALLBACK_GUEST_NAME);
    expect(extractGuestNameFromThread([{}, { body: null }]).name).toBe(FALLBACK_GUEST_NAME);
  });

  it('keeps two threads from bleeding into each other', () => {
    const florine = extractGuestNameFromThread([{ role: 'outgoing', body: 'Bonsoir Florine,\n ok' }]);
    const maxime = extractGuestNameFromThread([{ role: 'outgoing', body: 'Bonjour Maxime,\n oui' }]);
    expect(florine.name).toBe('Florine');
    expect(maxime.name).toBe('Maxime');
  });
});

describe('shouldReplaceStoredName', () => {
  const candidate = { name: 'Florine', source: 'host_greeting', confidence: CONFIDENCE.HOST_GREETING };

  it('replaces the "Airbnb" placeholder and legacy junk', () => {
    expect(shouldReplaceStoredName('Airbnb', 0, candidate)).toBe(true);
    expect(shouldReplaceStoredName('Voyageur', 0, candidate)).toBe(true);
    expect(shouldReplaceStoredName('dernière m', 0, candidate)).toBe(true);
    expect(shouldReplaceStoredName(null, 0, candidate)).toBe(true);
  });

  it('upgrades to a stronger source but never downgrades', () => {
    const strong = { name: 'Charlotte Martin', source: 'role_block', confidence: CONFIDENCE.ROLE_BLOCK };
    const weak = { name: 'Someone', source: 'signature', confidence: CONFIDENCE.SIGNATURE };

    expect(shouldReplaceStoredName('Florine', CONFIDENCE.HOST_GREETING, strong)).toBe(true);
    expect(shouldReplaceStoredName('Florine', CONFIDENCE.ROLE_BLOCK, weak)).toBe(false);
  });

  it('does not rewrite an identical name', () => {
    expect(shouldReplaceStoredName('Florine', CONFIDENCE.HOST_GREETING, candidate)).toBe(false);
    expect(shouldReplaceStoredName('FLORINE', CONFIDENCE.SIGNATURE, candidate)).toBe(false);
  });

  it('refuses a fallback candidate over a real stored name', () => {
    const fallback = { name: FALLBACK_GUEST_NAME, source: 'fallback', confidence: CONFIDENCE.NONE };
    expect(shouldReplaceStoredName('Florine', CONFIDENCE.HOST_GREETING, fallback)).toBe(false);
  });
});

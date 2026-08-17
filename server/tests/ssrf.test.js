/**
 * validateExternalUrl — barrière SSRF du connecteur iCal.
 *
 * Pourquoi cette fonction mérite ses propres tests : la page Calendrier laisse
 * un utilisateur authentifié saisir une URL, et le serveur va la CHERCHER
 * lui-même (icalService → ical.async.fromURL). Une URL pointant vers le réseau
 * interne transforme donc le serveur en relais vers sa propre infrastructure —
 * c'est le cas d'école du SSRF, et sur un hébergeur cloud l'adresse
 * 169.254.169.254 sert les identifiants de l'instance.
 *
 * L'ancienne liste comparait des préfixes littéraux et laissait passer :
 *   - 127.0.0.2 et tout le reste de 127.0.0.0/8 ("127.0.0.1" en préfixe ne
 *     couvre que lui-même) ;
 *   - [fd00::1] et les autres adresses IPv6 privées, l'IPv6 n'étant représenté
 *     que par le littéral "[::1]" ;
 *   - [::ffff:127.0.0.1], qui fait passer une boucle locale IPv4 en IPv6.
 *
 * Fonction pure : ni base, ni réseau.
 */

const { validateExternalUrl } = require('../utils/sanitize');

const accepts = (url) => validateExternalUrl(url).valid === true;

describe('adresses internes refusées', () => {
  const blocked = [
    // Boucle locale — tout le /8, pas seulement .1
    'https://127.0.0.1/cal.ics',
    'https://127.0.0.2/calendar',
    'https://127.42.7.9/cal.ics',
    'https://localhost/cal.ics',
    'https://localhost.localdomain/cal.ics',
    // RFC1918
    'https://10.0.0.5/cal.ics',
    'https://192.168.1.1/calendar',
    'https://172.16.0.1/cal.ics',
    'https://172.31.255.254/cal.ics',
    // Métadonnées cloud — la cible la plus rentable pour un attaquant
    'https://169.254.169.254/latest/meta-data/calendar',
    'https://metadata.google.internal/computeMetadata/v1/calendar',
    // CGNAT
    'https://100.64.0.1/cal.ics',
    // IPv6 privées et boucle locale
    'https://[::1]/cal.ics',
    'https://[fd00::1]/cal.ics',
    'https://[fc00::1]/cal.ics',
    'https://[fe80::1]/cal.ics',
    'https://[::ffff:127.0.0.1]/cal.ics',
    'https://[::ffff:10.0.0.1]/cal.ics',
    // Suffixes de réseau interne
    'https://nas.local/cal.ics',
    'https://serveur.internal/calendar',
    // "This" network
    'https://0.0.0.0/cal.ics',
  ];

  for (const url of blocked) {
    it(`refuse ${url}`, () => {
      expect(accepts(url)).toBe(false);
    });
  }
});

describe('protocoles refusés', () => {
  const blocked = [
    'file:///etc/passwd',
    'ftp://exemple.com/cal.ics',
    'gopher://exemple.com/cal.ics',
    'data:text/calendar;base64,QkVHSU4=',
    'pas-une-url',
    '',
  ];

  for (const url of blocked) {
    it(`refuse ${JSON.stringify(url)}`, () => {
      expect(accepts(url)).toBe(false);
    });
  }
});

describe('URLs publiques légitimes acceptées', () => {
  // Un faux refus casserait la connexion de calendrier : ces formes doivent passer.
  const allowed = [
    'https://www.airbnb.fr/calendar/ical/12345.ics?s=abcdef',
    'https://www.airbnb.com/calendar/ical/98765.ics',
    'https://admin.booking.com/hotel/ical/xyz.ics',
    'http://calendrier.exemple.com/feed.ics',
    'https://calendar.google.com/calendar/ical/x%40group.calendar.google.com/public/basic.ics',
    // Adresses publiques voisines des plages privées, à ne PAS confondre
    'https://11.0.0.1/cal.ics',
    'https://172.15.0.1/cal.ics',
    'https://172.32.0.1/cal.ics',
    'https://192.169.0.1/cal.ics',
    'https://100.63.0.1/cal.ics',
    'https://126.0.0.1/cal.ics',
  ];

  for (const url of allowed) {
    it(`accepte ${url}`, () => {
      expect(accepts(url)).toBe(true);
    });
  }
});

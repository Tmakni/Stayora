/**
 * Extraction de faits candidats depuis les messages de l'hôte.
 *
 * CE QUE CE FICHIER PROTÈGE
 * -------------------------
 * La moitié de ces tests vérifient qu'on n'extrait RIEN. C'est délibéré, et
 * c'est l'inverse de l'intuition : pour ce dispositif, empêcher une donnée
 * fausse vaut mieux que récupérer une donnée de plus. Une heure d'arrivée
 * absente se corrige en dix secondes dans le formulaire ; une heure d'arrivée
 * fausse est répétée à chaque voyageur jusqu'à ce que l'un d'eux se plaigne.
 *
 * Les phrases employées sont celles d'un export réel (reformulées et
 * anonymisées) : messages types d'accueil, procédures d'arrivée, rappels de
 * départ. Pas des phrases inventées pour arranger les motifs.
 */

const {
  extractCandidates, classifySentence, canonicalValue, isExclusive,
  STABILITY, VALUE_TYPE, FACT_KEYS,
  __normalizeTime: normalizeTime,
  __freeText: freeText,
} = require('../services/factExtraction');

/** Raccourci : la valeur extraite pour une clé, ou undefined. */
function valueOf(text, key) {
  const found = extractCandidates(text).find((c) => c.key === key);
  return found ? found.value : undefined;
}

function kindOf(text, key) {
  const found = extractCandidates(text).find((c) => c.key === key);
  return found ? found.kind : undefined;
}

// ────────────────────────────────────────────────────────────────────────────
describe('vocabulaire des faits', () => {
  it('chaque clé a une stabilité et un type', () => {
    for (const key of FACT_KEYS) {
      expect(STABILITY[key]).toBeDefined();
      expect(VALUE_TYPE[key]).toBeDefined();
    }
  });

  it('les codes et mots de passe sont volatils, les lieux sont stables', () => {
    expect(STABILITY.access_code).toBe('volatile');
    expect(STABILITY.gate_code).toBe('volatile');
    expect(STABILITY.wifi_password).toBe('volatile');
    expect(STABILITY.floor_number).toBe('stable');
    expect(STABILITY.parking_info).toBe('stable');
    expect(STABILITY.check_in_time).toBe('semi_stable');
  });

  it('seules les informations à valeur unique sont exclusives', () => {
    expect(isExclusive('check_in_time')).toBe(true);
    expect(isExclusive('access_code')).toBe(true);
    // Deux phrases sur le stationnement ne se contredisent pas.
    expect(isExclusive('parking_info')).toBe(false);
    expect(isExclusive('trash_instructions')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('normalisation des heures', () => {
  it('accepte les formes que les hôtes écrivent réellement', () => {
    expect(normalizeTime(['16', undefined, undefined])).toBe('16:00');
    expect(normalizeTime(['16', '30', undefined])).toBe('16:30');
    expect(normalizeTime(['5', '00', 'PM'])).toBe('17:00');
    expect(normalizeTime(['12', '00', 'am'])).toBe('00:00');
    expect(normalizeTime(['12', '00', 'pm'])).toBe('12:00');
  });

  it('refuse une heure impossible plutôt que de la corriger', () => {
    expect(normalizeTime(['25', undefined, undefined])).toBeNull();
    expect(normalizeTime(['10', '99', undefined])).toBeNull();
    // 13 h en notation AM/PM n'existe pas : la phrase est mal formée.
    expect(normalizeTime(['13', '00', 'pm'])).toBeNull();
  });

  it('reconnaît les formulations équivalentes du cahier des charges', () => {
    expect(valueOf('Le départ est à 10h', 'check_out_time')).toBe('10:00');
    expect(valueOf('Vous devez quitter le logement avant 10 heures', 'check_out_time')).toBe('10:00');
    expect(valueOf('Le check-out se fait à 10:00', 'check_out_time')).toBe('10:00');
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('extraction sur des messages réels', () => {
  const ARRIVAL = [
    "Bonjour Camille, j'espère que vous allez bien.",
    "je vous rappelle l adresse pour votre arrivée aujourd'hui à La Villa : 3 rue des Tests, 33000",
    "voici la procédure d arrivée : La boite à clé est située à côté de la porte d'entrée",
    'Le code de la boîte à clé est 0703',
    'Le nom du WiFi est : Livebox-A1D6 et le mot de passe : s7f2JFRbvJGNGTfD2S',
  ].join('\n');

  it('lit le code de la boîte à clés', () => {
    expect(valueOf(ARRIVAL, 'access_code')).toBe('0703');
  });

  it('lit le nom du réseau et le mot de passe séparément', () => {
    expect(valueOf(ARRIVAL, 'wifi_name')).toBe('Livebox-A1D6');
    expect(valueOf(ARRIVAL, 'wifi_password')).toBe('s7f2JFRbvJGNGTfD2S');
  });

  it("lit l'emplacement des clés", () => {
    expect(valueOf(ARRIVAL, 'key_location')).toMatch(/porte d'entrée/);
  });

  it('lit une heure annoncée « à partir de »', () => {
    const text = 'Ce message pour vous rappeler votre arrivée le 24 mars 2025 , à partir de 16:00 à Blanquefort';
    expect(valueOf(text, 'check_in_time')).toBe('16:00');
  });

  it('lit une heure écrite en notation anglaise', () => {
    const text = "L'heure d'arrivée est prévu à partir de : 5:00 PM et se fait de façon autonome";
    expect(valueOf(text, 'check_in_time')).toBe('17:00');
  });

  it('lit le départ sans le confondre avec l’arrivée', () => {
    const text = "Bonsoir, j'espère que votre séjour se passe bien.\nVotre départ est prévu à 11:00, demain matin";
    expect(valueOf(text, 'check_out_time')).toBe('11:00');
    expect(valueOf(text, 'check_in_time')).toBeUndefined();
  });

  it('lit le code du portail sans le confondre avec celui de la boîte à clés', () => {
    const text = 'Le code du portail est :1975 (bien refermer le portail derrière vous)';
    expect(valueOf(text, 'gate_code')).toBe('1975');
    expect(valueOf(text, 'access_code')).toBeUndefined();
  });

  it("lit l'étage", () => {
    expect(valueOf("l'adresse du logement est : 3ème étage, 52 Cours Vaillant", 'floor_number')).toBe('3');
    expect(valueOf('Appartement au 1er étage', 'floor_number')).toBe('1');
    expect(valueOf('Le logement est au rez-de-chaussée', 'floor_number')).toBe('0');
  });

  it("survit à la faute de frappe qui colle le nom du réseau au mot suivant", () => {
    const text = 'Le nom du WiFi est : Livebox-DF50et le mot de passe : kFySaC2xzgZCHYCbjL';
    expect(valueOf(text, 'wifi_name')).toBe('Livebox-DF50');
    expect(valueOf(text, 'wifi_password')).toBe('kFySaC2xzgZCHYCbjL');
  });

  it('reprend une consigne de stationnement mot pour mot', () => {
    const text = 'Vous arrivez sur le parking du château, vous pouvez stationner votre voiture.';
    expect(valueOf(text, 'parking_info')).toBe(text);
  });

  it("retire l'étiquette d'introduction sans toucher à la consigne", () => {
    const text = "voici la procédure d arrivée : La boite à clé est située sous le banc en bois";
    expect(valueOf(text, 'building_entry')).toBeUndefined();
    expect(valueOf(text, 'key_location')).toBe('sous le banc en bois');
  });

  it('ne compte qu’une preuve quand un message répète la même valeur', () => {
    const repeated = [
      'Le code de la boîte à clé est 0703',
      'Je répète : le code de la boîte à clé est 0703',
      'Encore une fois, le code de la boîte à clé est 0703',
    ].join('\n');
    const codes = extractCandidates(repeated).filter((c) => c.key === 'access_code');
    expect(codes).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('classification des phrases', () => {
  it('reconnaît une exception faite à un voyageur', () => {
    expect(classifySentence('Vous pouvez exceptionnellement arriver à 14h')).toBe('EXCEPTION');
    expect(classifySentence('Pour cette fois je vous laisse le logement jusqu’à 14h')).toBe('EXCEPTION');
    expect(classifySentence('Pour votre réservation je peux autoriser votre chien')).toBe('EXCEPTION');
    expect(classifySentence('À titre exceptionnel, le départ peut être à midi')).toBe('EXCEPTION');
  });

  it('reconnaît une mise à jour annoncée', () => {
    expect(classifySentence("L'heure d'arrivée est désormais 17h")).toBe('UPDATE');
    expect(classifySentence('Le nouveau code est 4321')).toBe('UPDATE');
    expect(classifySentence('Le code a changé')).toBe('UPDATE');
  });

  it('écarte les questions et les incidents', () => {
    expect(classifySentence('À quelle heure souhaitez-vous arriver ?')).toBe('AMBIGUOUS');
    expect(classifySentence('Le Wi-Fi ne marche pas aujourd’hui')).toBe('AMBIGUOUS');
    expect(classifySentence('Le portail est en panne')).toBe('AMBIGUOUS');
  });

  it("ne prend pas la formule d'accueil pour une exception", () => {
    // « pour votre séjour » ouvre chaque message type de cet hôte. La classer
    // en exception jetterait tout le corpus.
    const welcome = "Bonjour, merci d'avoir choisi La Villa Cosy pour votre séjour à Parempuyre.";
    expect(classifySentence(welcome)).toBe('CONFIRMATION');
  });

  it('la portée est la phrase, pas le message', () => {
    const message = [
      "Bonjour, merci d'avoir choisi La Villa pour votre séjour à Bordeaux.",
      'Exceptionnellement vous pouvez arriver à 14h.',
      "L'arrivée est à partir de 16h.",
    ].join('\n');
    // La phrase d'exception est marquée, celle qui suit ne l'est pas : les deux
    // valeurs sortent, avec des étiquettes différentes.
    const times = extractCandidates(message).filter((c) => c.key === 'check_in_time');
    expect(times.map((t) => `${t.value}:${t.kind}`).sort())
      .toEqual(['14:00:EXCEPTION', '16:00:CONFIRMATION']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
//
// Les cas de NON-extraction. Chacun vient du cahier des charges.
describe('ce qui ne doit RIEN produire', () => {
  it('« exceptionnellement à 14h » n’est pas l’heure d’arrivée', () => {
    // La valeur sort, mais marquée EXCEPTION : l'agrégation ne la comptera
    // jamais comme preuve.
    expect(kindOf('Vous pouvez exceptionnellement arriver à 14h', 'check_in_time')).toBe('EXCEPTION');
  });

  it('« je peux autoriser votre chien » n’autorise pas les animaux', () => {
    const text = 'Pour votre réservation je peux autoriser votre chien.';
    expect(valueOf(text, 'allows_pets')).toBeUndefined();
  });

  it('« le Wi-Fi ne marche pas » ne dit rien du Wi-Fi', () => {
    const text = 'Le Wi-Fi ne marche pas aujourd’hui, le technicien passe demain.';
    expect(extractCandidates(text)).toHaveLength(0);
  });

  it('« le parking du voisin exceptionnellement » n’est pas le parking du logement', () => {
    const text = 'Vous pouvez utiliser le parking du voisin exceptionnellement, il est absent cette semaine.';
    expect(kindOf(text, 'parking_info')).toBe('EXCEPTION');
  });

  it('une question ne renseigne rien', () => {
    expect(extractCandidates('À quelle heure comptez-vous arriver ? Le logement est prêt dès 15h ?')).toHaveLength(0);
  });

  it("« vous recevrez le code le jour de votre arrivée » ne donne pas de code", () => {
    const text = "L'arrivée se fait de façon autonome avec une boite à clé, vous recevrez le code le jour de votre arrivée.";
    expect(valueOf(text, 'access_code')).toBeUndefined();
    // La méthode d'arrivée, elle, est bien dite.
    expect(valueOf(text, 'checkin_method')).toBe('lockbox');
  });

  it('un espace réservé Airbnb n’est pas une valeur', () => {
    const text = 'Le nom du WiFi est : #{WIFI_NAME} et le mot de passe : #{WIFI_PASSWORD}';
    expect(valueOf(text, 'wifi_name')).toBeUndefined();
    expect(valueOf(text, 'wifi_password')).toBeUndefined();
  });

  it("un remplacement annoncé donne la NOUVELLE valeur, jamais l'ancienne", () => {
    const text = 'Le code de la boite à clé était 1234 mais il a été remplacé par 5678.';
    expect(valueOf(text, 'access_code')).toBe('5678');
    expect(kindOf(text, 'access_code')).toBe('UPDATE');
  });

  it('une phrase de politesse n’est pas une consigne', () => {
    expect(freeText('Bonjour Marie, le parking est devant la maison')).toBeNull();
  });

  it('un paragraphe entier n’entre pas dans un champ', () => {
    expect(freeText('parking')).toBeNull();
    expect(freeText(`Le parking ${'très '.repeat(80)}loin`)).toBeNull();
  });

  it('une clé inconnue n’est jamais produite', () => {
    const text = 'Le jacuzzi est chauffé à 38 degrés et la piscine ouvre à 9h.';
    for (const candidate of extractCandidates(text)) {
      expect(FACT_KEYS).toContain(candidate.key);
    }
  });

  it('un texte vide ou absurde ne produit rien', () => {
    expect(extractCandidates('')).toHaveLength(0);
    expect(extractCandidates(null)).toHaveLength(0);
    expect(extractCandidates('👍')).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('regroupement des formulations équivalentes', () => {
  it('un nom de réseau écrit avec ou sans espaces est le même', () => {
    expect(canonicalValue('wifi_name', 'Riviere & Spa'))
      .toBe(canonicalValue('wifi_name', 'Riviere&Spa'));
  });

  it('un mot de passe garde ses espaces et sa casse', () => {
    expect(canonicalValue('wifi_password', 'AEaz kq9a'))
      .not.toBe(canonicalValue('wifi_password', 'AEazkq9a'));
    expect(canonicalValue('wifi_password', 'Secret'))
      .not.toBe(canonicalValue('wifi_password', 'secret'));
  });

  it('une consigne ponctuée différemment est la même consigne', () => {
    expect(canonicalValue('parking_info', 'Le parking est derrière la maison.'))
      .toBe(canonicalValue('parking_info', 'le parking est derrière la maison'));
  });

  it('deux heures différentes restent différentes', () => {
    expect(canonicalValue('check_in_time', '16:00'))
      .not.toBe(canonicalValue('check_in_time', '17:00'));
  });
});

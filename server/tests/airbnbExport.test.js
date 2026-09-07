/**
 * Lecture structurée de l'export de données personnelles Airbnb.
 *
 * LES DONNÉES DE CE FICHIER
 * -------------------------
 * Les objets ci-dessous reproduisent la FORME exacte d'un export réel — noms
 * de clés, imbrication, types, jusqu'à la faute de frappe `childrenAlloewd`
 * qu'Airbnb livre telle quelle. Les valeurs, elles, sont inventées : aucune
 * donnée personnelle n'entre dans ce dépôt.
 *
 * CE QUI EST VERROUILLÉ ICI
 * -------------------------
 *   - le titre vient de `listingDescriptions[0].name`, pas de `nickname` :
 *     c'est le bogue qui ne laissait détecter que 8 annonces sur 43 ;
 *   - un identifiant de 19 chiffres survit à l'analyse JSON ;
 *   - `listing_permits.json` se rattache par `listingUrl`, pas par un
 *     identifiant, et le rattachement fonctionne réellement ;
 *   - aucun champ ne peut finir en « [object Object] » ;
 *   - la liste blanche laisse fermés les fichiers sensibles ;
 *   - `listings.json` fait foi : les autres fichiers enrichissent sans écraser.
 */

const {
  parseExportDocuments,
  parseAirbnbJson,
  isListingFile,
  exportKind,
  __mergeConsecutiveDates,
} = require('../services/airbnbExport');

// Un identifiant Airbnb récent : 19 chiffres, bien au-delà de 2^53 − 1.
const BIG_ID = '1684090983577235984';
const SMALL_ID = '39244203';

function listingsDoc(listings) {
  return { name: 'listings.json', data: [{ listings }] };
}

/** Une annonce à la forme réelle de l'export. */
function rawListing(overrides = {}) {
  return {
    id: Number(SMALL_ID),
    nickname: null,
    propertyType: 'House',
    roomType: 'Entire home/apt',
    bathroomType: 'private',
    bedType: 'Real Bed',
    bedrooms: 2,
    beds: 3,
    bathrooms: 1.5,
    personCapacity: 5,
    city: 'Parempuyre',
    cityNative: 'Parempuyre',
    state: 'Nouvelle-Aquitaine',
    country: 'FR',
    zipcode: '33290',
    street: '12 Rue des Ardillères',
    formattedAddress: '12 Rue des Ardillères, 33290 Parempuyre, France',
    lat: 44.95,
    lng: -0.59,
    directions: 'Le portail à côté du bananier.',
    houseManual: 'Le compteur est sous l’escalier.',
    license: '3306301480413',
    instantBook: true,
    petsAllowed: false,
    smokingAllowed: false,
    eventsAllowed: false,
    infantsAllowed: true,
    childrenAlloewd: true,          // la faute est celle de l'export Airbnb
    amenities: ['wireless_internet', 'kitchen', 'pool', 'free_parking', 'tv', 'essentials'],
    expectations: [
      {
        listingId: Number(SMALL_ID),
        expectationType: 'shared_spaces',
        locale: 'fr',
        addedDetails: 'la piscine et la cuisine d’été',
        hasExpectation: true,
      },
    ],
    listingDescriptions: [
      {
        name: 'Studio CHIC et cosy',
        summary: 'Résumé court.',
        description: 'Description longue du logement.',
        neighborhoodOverview: 'À dix minutes du centre.',
        space: 'Un espace agréable.',
        notes: 'Café offert.',
        interaction: 'Je vous accueille.',
        language: 'fr',
        tier: 'MARKETPLACE',
      },
    ],
    rooms: [
      {
        id: 1, listingId: Number(SMALL_ID), roomNumber: 1, roomType: 'BEDROOM',
        isPrivate: true, amenities: ['BED_LINENS', 'DOUBLE_BED', 'HANGERS'],
      },
    ],
    photos: [{ name: 'a.jpg', fileType: 'JPEG', createdAt: 1570630803.0 }],
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────────────
describe('liste blanche des fichiers', () => {
  it('ouvre les quatre fichiers de logement', () => {
    for (const name of ['listings.json', 'listing_pricing.json', 'listing_calendar.json', 'listing_permits.json']) {
      expect(isListingFile(name)).toBe(true);
      expect(exportKind(name)).toBeTruthy();
    }
  });

  it("n'ouvre aucun fichier personnel ou financier", () => {
    const forbidden = [
      'activity_log.json', 'messages.json', 'payment_processing.json',
      'payment_instruments.json', 'payments_asset_ledger.json', 'host_payouts.json',
      'payout_authentication.json', 'id_verification.json', 'host_kyc_information.json',
      'search_history.json', 'search_telemetry_signals.json', 'profile_information.json',
      'wishlists.json', 'third_party_payees_and_payouts.json', 'coupons_and_credits.json',
      'airbnb_customer_support.json', 'resolution_center_claims.json',
      'guest_referrals.json', 'report_history.json',
    ];
    for (const name of forbidden) expect(isListingFile(name)).toBe(false);
  });

  // Ces trois-là ont rejoint la liste blanche : ils apportent la note moyenne,
  // les séjours à venir et les modèles de message écrits par l'hôte.
  it('ouvre les avis, les séjours et les réponses rapides', () => {
    for (const name of ['reviews.json', 'reservations.json', 'host_quick_replies.json']) {
      expect(isListingFile(name)).toBe(true);
      expect(exportKind(name)).toBeTruthy();
    }
  });

  it("laisse messages.json fermé, malgré ce qu'il contient d'utile", () => {
    // Rien n'y prouve qu'une phrase décrit le logement plutôt qu'une exception
    // faite à un voyageur : la prudence l'emporte sur la couverture.
    expect(isListingFile('messages.json')).toBe(false);
  });

  it('un fichier sensible reste fermé même rangé dans un dossier « listings »', () => {
    expect(isListingFile('listings/payment_processing.json')).toBe(false);
    expect(isListingFile('export/listings/messages.json')).toBe(false);
  });

  it("accepte un nom d'un autre millésime, confié alors à l'heuristique", () => {
    expect(isListingFile('mes_annonces.json')).toBe(true);
    expect(exportKind('mes_annonces.json')).toBeNull();
  });

  it('refuse ce qui n\'est pas du JSON', () => {
    expect(isListingFile('listings.csv')).toBe(false);
    expect(isListingFile('listings.json.exe')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('identifiants de 19 chiffres', () => {
  it("survit à l'analyse JSON", () => {
    const parsed = parseAirbnbJson(`{"id": ${BIG_ID}}`);
    expect(String(parsed.id)).toBe(BIG_ID);
  });

  it('JSON.parse nu, lui, le corrompt — c’est bien le bogue corrigé', () => {
    expect(String(JSON.parse(`{"id": ${BIG_ID}}`).id)).not.toBe(BIG_ID);
  });

  it('ne touche pas aux nombres qui ne sont pas des identifiants', () => {
    const parsed = parseAirbnbJson('{"amount": 89, "createdAt": 1570630803, "minNights": 2}');
    expect(parsed.amount).toBe(89);
    expect(parsed.createdAt).toBe(1570630803);
    expect(parsed.minNights).toBe(2);
  });

  it("ne touche pas à un long nombre écrit dans un texte", () => {
    const parsed = parseAirbnbJson('{"notes": "appelez le 1684090983577235984, merci"}');
    expect(parsed.notes).toBe('appelez le 1684090983577235984, merci');
  });

  it('supporte un BOM en tête de fichier', () => {
    expect(parseAirbnbJson('﻿{"a":1}')).toEqual({ a: 1 });
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('lecture de listings.json', () => {
  it('prend le vrai titre dans listingDescriptions, pas le surnom interne', () => {
    const { listings } = parseExportDocuments([listingsDoc([
      rawListing({ nickname: 'Chambre 7' }),
    ])]);
    expect(listings[0].name).toBe('Studio CHIC et cosy');
  });

  it('détecte une annonce SANS surnom — le cas que l’ancien code ratait', () => {
    const { listings } = parseExportDocuments([listingsDoc([rawListing({ nickname: null })])]);
    expect(listings).toHaveLength(1);
    expect(listings[0].name).toBe('Studio CHIC et cosy');
  });

  it('retombe sur le surnom quand il n’y a aucune description', () => {
    const { listings } = parseExportDocuments([listingsDoc([
      rawListing({ nickname: 'Maison 2', listingDescriptions: [] }),
    ])]);
    expect(listings[0].name).toBe('Maison 2');
  });

  it('écarte une annonce sans aucun nom exploitable plutôt que d’en inventer un', () => {
    const { listings } = parseExportDocuments([listingsDoc([
      rawListing({ nickname: null, listingDescriptions: [] }),
    ])]);
    expect(listings).toEqual([]);
  });

  it('remplit les caractéristiques', () => {
    const [listing] = parseExportDocuments([listingsDoc([rawListing()])]).listings;
    expect(listing).toMatchObject({
      external_listing_id: SMALL_ID,
      property_type: 'house',
      bedrooms: 2,
      beds: 3,
      max_guests: 5,
      city: 'Parempuyre',
      country: 'France',                 // « FR » est traduit pour le formulaire
      address: '12 Rue des Ardillères, 33290 Parempuyre, France',
      description: 'Description longue du logement.',
      nearby: 'À dix minutes du centre.',
      building_entry: 'Le portail à côté du bananier.',
      house_manual: 'Le compteur est sous l’escalier.',
      registration_number: '3306301480413',
      import_status: 'ready',
    });
    // La colonne est entière : 1.5 salle de bain est arrondie, pas perdue.
    expect(listing.bathrooms).toBe(2);
  });

  it('coche les équipements et laisse les autres à false', () => {
    const [listing] = parseExportDocuments([listingsDoc([rawListing()])]).listings;
    expect(listing.has_wifi).toBe(true);
    expect(listing.has_kitchen).toBe(true);
    expect(listing.has_pool).toBe(true);
    expect(listing.has_parking).toBe(true);
    expect(listing.has_tv).toBe(true);
    // « essentials » couvre serviettes et produits de toilette chez Airbnb.
    expect(listing.has_towels).toBe(true);
    expect(listing.has_toiletries).toBe(true);
    // Jamais coché à tort : le jacuzzi n'est pas dans la liste.
    expect(listing.has_jacuzzi).toBeUndefined();
  });

  it('ignore un code d’équipement inconnu au lieu de cocher au hasard', () => {
    const [listing] = parseExportDocuments([listingsDoc([
      rawListing({ amenities: ['equipement_du_futur', 'wireless_internet'] }),
    ])]).listings;
    expect(listing.has_wifi).toBe(true);
    expect(JSON.stringify(listing)).not.toContain('equipement_du_futur');
  });

  it('ne déduit PAS « studio » d’un logement à zéro chambre', () => {
    // Airbnb ne dit nulle part que c'en est un. Le type traduit reste celui
    // qu'Airbnb annonce, et le nombre de chambres reste zéro.
    const [listing] = parseExportDocuments([listingsDoc([
      rawListing({ bedrooms: 0, propertyType: 'Guest suite' }),
    ])]).listings;
    expect(listing.property_type).toBe('apartment');
    expect(listing.bedrooms).toBe(0);
  });

  it('n’écrit pas un type de logement absent du menu du formulaire', () => {
    const [listing] = parseExportDocuments([listingsDoc([
      rawListing({ propertyType: 'Yurt', bedrooms: 1 }),
    ])]).listings;
    expect(listing.property_type).toBeUndefined();
  });

  it('compose les règles à partir des booléens et des points à noter', () => {
    const [listing] = parseExportDocuments([listingsDoc([
      rawListing({ bathroomType: 'shared', childrenAlloewd: false }),
    ])]).listings;
    expect(listing.allows_pets).toBe(false);
    expect(listing.allows_smoking).toBe(false);
    expect(listing.house_rules).toContain('Espaces partagés : la piscine et la cuisine d’été');
    expect(listing.house_rules).toContain('Salle de bain partagée');
    expect(listing.house_rules).toContain('Enfants non acceptés');
  });

  it('lit la literie sans confondre le linge de lit avec un lit', () => {
    const [listing] = parseExportDocuments([listingsDoc([rawListing()])]).listings;
    expect(listing.bed_types).toBe('Chambre 1 : lit double');
    expect(listing.bed_types).not.toMatch(/linens/i);
  });

  it('ne rend JAMAIS « [object Object] », même sur des valeurs aberrantes', () => {
    const [listing] = parseExportDocuments([listingsDoc([
      rawListing({
        city: { nested: 'objet' },
        directions: ['un', 'tableau'],
        license: { number: 42 },
        formattedAddress: null,
      }),
    ])]).listings;
    expect(JSON.stringify(listing)).not.toContain('[object Object]');
    // L'adresse retombe sur les composants, elle n'est pas perdue.
    expect(listing.address).toContain('33290');
  });

  it('supporte un fichier vide ou mal formé sans lever', () => {
    expect(parseExportDocuments([{ name: 'listings.json', data: null }]).listings).toEqual([]);
    expect(parseExportDocuments([{ name: 'listings.json', data: [] }]).listings).toEqual([]);
    expect(parseExportDocuments([listingsDoc([null, 42, 'texte'])]).listings).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('enrichissement par les autres fichiers', () => {
  const pricingDoc = {
    name: 'listing_pricing.json',
    data: [{
      pricingData: [{
        listingId: SMALL_ID,
        listingPriceSetting: {
          defaultDailyPrice: { amount: 89, currency: 'EUR' },
          weekendPrice: { amount: 95, currency: 'EUR' },
          weeklyPriceFactor: 0.9,
          monthlyPriceFactor: 0.8,
          securityDeposit: { amount: 500, currency: 'EUR' },
          pricePerExtraPerson: { amount: 10, currency: 'EUR' },
          guestsIncluded: 2,
          listingCurrency: 'EUR',
        },
        smartPricingSetting: { isEnabled: false, minPrice: { amount: 57, currency: 'EUR' } },
        customPricings: { customDailyPrices: [] },
      }],
      // Ne porte aucun identifiant : rien ne doit en être tiré.
      pricingRules: [{ pricingRuleDatas: [{ priceChange: -7, ruleType: 'STAYED_AT_LEAST_X_DAYS' }] }],
    }],
  };

  const calendarDoc = {
    name: 'listing_calendar.json',
    data: [{
      listingsCalendarData: [{
        listingId: SMALL_ID,
        globalCalendarData: { maxDaysNotice: { maxDaysNotice: 180 } },
        seasonalCalendarData: {
          seasonalMinNights: [
            { minNights: 2, startDate: '2099-01-01', endDate: '2099-01-05', checkinAllowedOn: 'ALL' },
            { minNights: 2, startDate: '2099-02-01', endDate: '2099-02-05', checkinAllowedOn: 'ALL' },
            { minNights: 1, startDate: '2099-03-01', endDate: '2099-03-02', checkinAllowedOn: 'ALL' },
          ],
        },
        dailyCalendarData: {
          busyOverrides: [
            { busyReason: ['HOST_BUSY'], calendarDate: '2099-07-01' },
            { busyReason: ['HOST_BUSY'], calendarDate: '2099-07-02' },
            { busyReason: ['HOST_BUSY'], calendarDate: '2099-07-05' },
            { busyReason: ['HOST_BUSY'], calendarDate: '2000-01-01' },  // passé
          ],
          minNightOverrides: [],
          availableOverrides: [],
        },
      }],
      ruleGroupAvailabilityRules: [{ daysClosedForCheckin: ['FRIDAY'] }],
    }],
  };

  const permitsDoc = {
    name: 'listing_permits.json',
    data: [{
      listingRegistrations: [{
        // Le rattachement se fait par l'URL : ce fichier ne porte pas
        // d'identifiant, et c'est tout l'intérêt du test.
        listingUrl: `https://www.airbnb.com/rooms/${SMALL_ID}`,
        registrations: [{
          registrationSubmissions: [{
            regulatoryBody: 'Bordeaux France',
            type: 'Existing registration',
            time: '2026-05-13T08:55:00Z',
            data: { attestation: true, permit_number: '999888777', listing_address: '9 rue Déclarée, Bordeaux' },
          }],
        }],
      }],
    }],
  };

  it('rattache tarifs, calendrier et permis au bon logement', () => {
    const { listings, sources } = parseExportDocuments([
      listingsDoc([rawListing()]), pricingDoc, calendarDoc, permitsDoc,
    ]);
    expect(listings).toHaveLength(1);
    expect(listings[0].found).toMatchObject({
      general: true, address: true, capacity: true, amenities: true,
      pricing: true, calendar: true, permits: true,
    });
    expect(sources).toMatchObject({ listings: true, pricing: true, calendar: true, permits: true });
  });

  it('traduit les tarifs en champs lisibles, jamais en objets', () => {
    const [listing] = parseExportDocuments([listingsDoc([rawListing()]), pricingDoc]).listings;
    expect(listing.payment_notes).toContain('Tarif de base 89 EUR par nuit');
    expect(listing.payment_notes).toContain('Week-end 95 EUR');
    expect(listing.payment_notes).toContain('Remise à la semaine 10 %');
    expect(listing.payment_notes).toContain('Remise au mois 20 %');
    // Tarification intelligente désactivée : on ne l'annonce pas.
    expect(listing.payment_notes).not.toContain('intelligente');
    expect(listing.has_deposit_required).toBe(true);
    expect(listing.deposit_amount).toBe('500 EUR');
    expect(listing.has_price_per_guest).toBe(true);
    expect(listing.price_extra_guest_amount).toBe('10 EUR');
    // Le supplément commence AU-DELÀ des 2 voyageurs inclus.
    expect(listing.extra_guest_threshold).toBe('3');
  });

  it('retient la durée minimale EN VIGUEUR et les dates à venir', () => {
    const [listing] = parseExportDocuments([listingsDoc([rawListing()]), calendarDoc]).listings;
    // Aucune des trois périodes du fichier ne couvre aujourd'hui : le champ
    // reste vide plutôt que de recevoir la valeur la plus fréquente, qui ne
    // serait la règle d'aucune date réelle.
    expect(listing.min_stay).toBeUndefined();
    // Deux plages : les 1er-2 juillet fusionnés, puis le 5. Le blocage de
    // l'an 2000 est écarté — un calendrier passé n'apprend rien.
    expect(listing.blocked_dates).toEqual([
      { start_date: '2099-07-01', end_date: '2099-07-03' },
      { start_date: '2099-07-05', end_date: '2099-07-06' },
    ]);
  });

  it('rattache les permis malgré une clé de liaison différente', () => {
    const [listing] = parseExportDocuments([
      listingsDoc([rawListing({ license: null, formattedAddress: '' , street: '', zipcode: '', city: '', country: '' })]),
      permitsDoc,
    ]).listings;
    expect(listing.registration_number).toBe('999888777');
    // L'adresse déclarée sert de repli quand l'annonce n'en porte pas.
    expect(listing.address).toBe('9 rue Déclarée, Bordeaux');
  });

  it('listings.json fait foi : les autres fichiers n’écrasent rien', () => {
    const [listing] = parseExportDocuments([listingsDoc([rawListing()]), permitsDoc]).listings;
    expect(listing.address).toBe('12 Rue des Ardillères, 33290 Parempuyre, France');
    expect(listing.registration_number).toBe('3306301480413');
  });

  it('un identifiant de 19 chiffres se rattache correctement', () => {
    const documents = [
      // Sans licence dans l'annonce, pour que le numéro observé ne puisse
      // venir que du rattachement au fichier des permis.
      listingsDoc([rawListing({ id: BIG_ID, license: null })]),
      {
        name: 'listing_permits.json',
        data: [{
          listingRegistrations: [{
            listingUrl: `https://www.airbnb.com/rooms/${BIG_ID}`,
            registrations: [{
              registrationSubmissions: [{ data: { permit_number: 'ABC123' } }],
            }],
          }],
        }],
      },
    ];
    const [listing] = parseExportDocuments(documents).listings;
    expect(listing.external_listing_id).toBe(BIG_ID);
    expect(listing.found.permits).toBe(true);
    expect(listing.registration_number).toBe('ABC123');
  });

  it('un logement absent de listings.json n’est pas créé depuis les tarifs', () => {
    const orphan = {
      name: 'listing_pricing.json',
      data: [{ pricingData: [{ listingId: '11112222', listingPriceSetting: {} }] }],
    };
    const { listings } = parseExportDocuments([listingsDoc([rawListing()]), orphan]);
    expect(listings).toHaveLength(1);
    expect(listings[0].external_listing_id).toBe(SMALL_ID);
  });

  it('un fichier annexe vide ne coche pas la case correspondante', () => {
    const { listings, sources } = parseExportDocuments([
      listingsDoc([rawListing()]),
      { name: 'listing_pricing.json', data: [{ pricingData: [] }] },
    ]);
    expect(listings[0].found.pricing).toBe(false);
    expect(sources.pricing).toBe(false);
  });

  it('un calendrier lu mais sans date bloquée ne coche pas « Calendrier »', () => {
    const empty = {
      name: 'listing_calendar.json',
      data: [{ listingsCalendarData: [{
        listingId: SMALL_ID,
        seasonalCalendarData: { seasonalMinNights: [] },
        dailyCalendarData: { busyOverrides: [], minNightOverrides: [], availableOverrides: [] },
      }] }],
    };
    const [listing] = parseExportDocuments([listingsDoc([rawListing()]), empty]).listings;
    expect(listing.found.calendar).toBe(false);
    // Le tableau existe malgré tout : c'est lui qui dit « lu, rien de bloqué »
    // et qui permettra de libérer des dates bloquées lors d'un import précédent.
    expect(listing.blocked_dates).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('fusion des dates bloquées', () => {
  it('regroupe les jours consécutifs, fin exclusive', () => {
    expect(__mergeConsecutiveDates(['2026-01-01', '2026-01-02', '2026-01-03'])).toEqual([
      { start_date: '2026-01-01', end_date: '2026-01-04' },
    ]);
  });

  it('coupe sur un trou', () => {
    expect(__mergeConsecutiveDates(['2026-01-01', '2026-01-03'])).toEqual([
      { start_date: '2026-01-01', end_date: '2026-01-02' },
      { start_date: '2026-01-03', end_date: '2026-01-04' },
    ]);
  });

  it('franchit un changement de mois et une année bissextile', () => {
    expect(__mergeConsecutiveDates(['2024-02-28', '2024-02-29', '2024-03-01'])).toEqual([
      { start_date: '2024-02-28', end_date: '2024-03-02' },
    ]);
  });

  it('supporte une liste vide et les doublons', () => {
    expect(__mergeConsecutiveDates([])).toEqual([]);
    expect(__mergeConsecutiveDates(['2026-01-01', '2026-01-01'])).toEqual([
      { start_date: '2026-01-01', end_date: '2026-01-02' },
    ]);
  });
});

const logger = require('../utils/logger');
const {
  validateAirbnbUrl,
  safeFetch,
  extractListingId,
  resolveShortLink,
  resolveListingTitle,
  isValidListingName,
  isPlaceholderName,
  cleanListingTitle,
} = require('../services/airbnbListingResolver');

const AIRBNB_API_KEY = 'd306zoyjsyarp7ifhu67rjxn52tv0t20';
const AIRBNB_API_KEY_V3 = 'd306zoyjsyarp7ifhu67rjxn52tv0t20';

/**
 * Try Airbnb's internal API endpoints to fetch structured listing data.
 * Uses the public frontend API key embedded in Airbnb's own JavaScript.
 */
async function fetchViaAirbnbApi(listingId) {
  const endpoints = [
    `https://www.airbnb.com/api/v3/pdp_listing_details/${listingId}?_format=for_rooms_show&_p3_impression_id=p3_${Date.now()}_0&guests=1&adults=1`,
    `https://www.airbnb.com/api/v2/pdp_listing_details/${listingId}?_format=for_rooms_show&_p3_impression_id=p3_${Date.now()}_0&guests=1&adults=1`,
    `https://www.airbnb.com/api/v2/listings/${listingId}?_format=v1_legacy_for_p3`,
  ];

  for (const apiUrl of endpoints) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(apiUrl, {
        signal: controller.signal,
        headers: {
          'X-Airbnb-API-Key': AIRBNB_API_KEY,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8',
        }
      });

      clearTimeout(timeout);

      if (!response.ok) {
        logger.warn(`Airbnb API returned ${response.status} for listing ${listingId}`);
        continue;
      }

      const data = await response.json();
      if (data && Object.keys(data).length > 0) {
        logger.info(`Airbnb API returned data for listing ${listingId}`);
        return data;
      }
    } catch (err) {
      logger.warn(`Airbnb API error for ${listingId}: ${err.message}`);
    }
  }

  return null;
}

// extractListingId now lives in services/airbnbListingResolver.js alongside the
// URL allowlist, so id parsing and host validation cannot drift apart. It also
// understands /rooms/plus/<id>, ?listing_id=, and /h/<slug>-<id> links.

/**
 * Map Airbnb amenity names/categories to our boolean fields
 */
function mapAmenities(amenities = []) {
  // Airbnb returns amenities in multiple shapes — collect all possible text tokens
  const names = [];
  for (const a of amenities) {
    // Flat amenity object { name, title, nameKey, id }
    const tokens = [a.name, a.title, a.nameKey, a.id, a.amenityId, a.iconKey];
    // Grouped format: { groupTitle, amenities: [...] }
    if (Array.isArray(a.amenities)) {
      for (const sub of a.amenities) {
        tokens.push(sub.name, sub.title, sub.nameKey, sub.id, sub.amenityId, sub.iconKey);
      }
    }
    for (const t of tokens) {
      if (t) names.push(String(t).toLowerCase());
    }
  }
  const has = (keywords) => keywords.some(kw => names.some(n => n.includes(kw)));

  return {
    // === Essentiels ===
    has_wifi:             has(['wifi', 'wi-fi', 'wireless', 'internet', 'réseau']),
    has_kitchen:          has(['kitchen', 'cuisine', 'cook', 'kitchenette']),
    has_parking:          has(['parking', 'garage', 'stationnement', 'car park']),
    has_pool:             has(['pool', 'piscine', 'swimming']),
    has_gym:              has(['gym', 'fitness', 'exercise', 'sport', 'musculation']),
    has_tv:               has(['tv', 'television', 'télévision', 'cable', 'hdtv', 'smart tv']),
    has_washing_machine:  has(['washer', 'washing machine', 'laundry', 'lave-linge', 'lavomat']),
    has_air_conditioning: has(['air conditioning', 'ac', 'a/c', 'climatisation', 'cooling', 'climatiseur']),
    has_heating:          has(['heating', 'chauffage', 'heat', 'radiateur', 'central heat']),
    has_workspace:        has(['workspace', 'dedicated workspace', 'desk', 'bureau', 'work area']),
    has_hair_dryer:       has(['hair dryer', 'hairdryer', 'sèche-cheveux', 'seche cheveux', 'blowdryer']),
    has_iron:             has(['iron', 'fer à repasser', 'fer a repasser', 'ironing', 'pressing']),
    // === Salle de bain ===
    has_bathtub:          has(['bathtub', 'bath tub', 'baignoire', 'tub', 'soaking tub', 'bain']),
    // === Chambre & linge ===
    has_dryer:            has(['dryer', 'sèche-linge', 'seche-linge', 'tumble dryer', 'séchoir']),
    // === Cuisine étendue ===
    has_dishwasher:       has(['dishwasher', 'lave-vaisselle', 'vaisselle']),
    has_microwave:        has(['microwave', 'micro-ondes', 'microondes', 'four micro']),
    has_refrigerator:     has(['refrigerator', 'fridge', 'réfrigérateur', 'frigidaire', 'réfrigérateur', 'freezer']),
    has_coffee_maker:     has(['coffee maker', 'coffee machine', 'machine à café', 'nespresso', 'expresso', 'espresso', 'cafetière', 'cafetiere', 'keurig']),
    // === Sécurité ===
    has_smoke_detector:   has(['smoke detector', 'smoke alarm', 'détecteur de fumée', 'detecteur de fumee', 'fire alarm']),
    has_carbon_monoxide_detector: has(['carbon monoxide', 'co detector', 'monoxyde de carbone', 'co alarm']),
    has_fire_extinguisher: has(['fire extinguisher', 'extincteur', 'fire safety']),
    has_first_aid_kit:    has(['first aid', 'first aid kit', 'trousse de secours', 'trousse premiers secours', 'medical kit']),
    // === Extérieur ===
    has_bbq:              has(['bbq', 'barbecue', 'grill', 'plancha', 'outdoor grill']),
    has_terrace:          has(['terrace', 'balcony', 'terrasse', 'balcon', 'patio', 'deck', 'outdoor space']),
    has_garden:           has(['garden', 'yard', 'jardin', 'backyard', 'outdoor area', 'pré', 'lawn']),
    // === Divertissement ===
    has_netflix:          has(['netflix', 'streaming', 'amazon prime', 'hbo', 'disney', 'apple tv']),
    has_fireplace:        has(['fireplace', 'cheminée', 'cheminee', 'fire place', 'foyer', 'wood stove', 'poêle'])
  };
}

/**
 * Extract house rules from PDP sections or direct fields
 */
function extractHouseRules(raw, get) {
  // Try direct text fields first
  const direct = get('house_rules', 'houseRules', 'additional_house_rules', 'additionalHouseRules');

  // Try PDP sections (newer Airbnb format)
  const sections = [
    ...(get('pdp_listing_detail.pdp_listing_sections') || []),
    ...(get('pdpListingDetail.pdpListingSections') || []),
    ...(get('sectionsInfo.sections') || []),
  ];

  const ruleLines = [];
  for (const section of sections) {
    const type = (
      section?.sectionComponentType ||
      section?.section_component_type ||
      section?.sectionType ||
      ''
    ).toUpperCase();

    if (type.includes('RULE') || type.includes('POLICY') || type.includes('HOUSE_MANUAL')) {
      // preview lines style
      if (Array.isArray(section?.previewLines)) {
        section.previewLines.forEach(l => {
          const txt = l?.body || l?.title || '';
          if (txt) ruleLines.push(txt);
        });
      }
      // structured items style
      const gc = section?.guestControls || section?.guest_controls;
      if (gc?.structuredHouseRuleItems) {
        gc.structuredHouseRuleItems.forEach(r => {
          const label = r?.title || r?.name || '';
          const body  = r?.body  || r?.subtitle || '';
          if (label) ruleLines.push(body ? `${label}: ${body}` : label);
        });
      }
      // host rules HTML (strip tags)
      if (section?.hostRulesHtml) {
        ruleLines.push(section.hostRulesHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      }
      // simple body text
      if (section?.body?.htmlText) {
        ruleLines.push(section.body.htmlText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      }
    }

    // Check-in / check-out from AVAILABILITY section
    if (type.includes('AVAILABILITY') || type.includes('CHECKIN')) {
      const checkin  = section?.checkInTime  || section?.check_in_time;
      const checkout = section?.checkOutTime || section?.check_out_time;
      if (checkin)  ruleLines.push(`Check-in : ${checkin}`);
      if (checkout) ruleLines.push(`Check-out : ${checkout}`);
    }
  }

  if (ruleLines.length > 0) return ruleLines.join('\n');
  return direct || '';
}

/**
 * Extract best available address / location string
 */
function extractAddress(raw, get) {
  // Try structured location object first
  const loc = get('location', 'listing_location');
  if (loc && typeof loc === 'object') {
    const parts = [
      loc.street || loc.address || '',
      loc.city || loc.neighbourhood || '',
      loc.state || loc.region || '',
      loc.country || '',
    ].filter(Boolean);
    if (parts.length >= 2) return parts.join(', ');
  }
  // Fallback to single string fields
  return (
    get('public_address', 'publicAddress') ||
    get('location.city', 'city', 'neighbourhood', 'neighborhood') ||
    ''
  );
}

/**
 * Try to extract structured listing data from Airbnb __NEXT_DATA__ or similar blobs
 */
function parseListing(data, listingId) {
  // Try multiple known data shapes across Airbnb's various frontend versions
  const candidates = [
    () => data?.props?.pageProps?.listing,
    () => data?.props?.pageProps?.bootstrapData?.reduxData?.homePDP?.listingInfo?.listing,
    () => data?.props?.pageProps?.bootstrapData?.reduxData?.hotellier?.listing,
    () => {
      const queries = data?.props?.dehydratedState?.queries || [];
      for (const q of queries) {
        const listing = q?.state?.data?.listing || q?.state?.data?.merlin?.listing;
        if (listing) return listing;
      }
      return null;
    },
    () => {
      const info = data?.props?.pageProps?.bootstrapData?.reduxData?.homePDP?.listingInfo;
      return info?.listing || info || null;
    },
    // Airbnb API response: pdp_listing_details endpoint
    () => {
      const pdp = data?.pdp_listing_detail;
      if (!pdp) return null;
      const listing = pdp.listing || pdp;
      // Attach PDP sections so get('pdp_listing_detail.pdp_listing_sections') works
      if (pdp.pdp_listing_sections && !listing.pdp_listing_detail) {
        listing.pdp_listing_detail = { pdp_listing_sections: pdp.pdp_listing_sections };
      }
      // Merge sectioned_description fields into listing
      if (pdp.sectioned_description) {
        for (const key of ['description', 'space', 'transit', 'neighborhood_overview', 'access']) {
          if (!listing[key] && pdp.sectioned_description[key]) listing[key] = pdp.sectioned_description[key];
        }
      }
      return listing;
    },
    // Airbnb API response: listings endpoint
    () => data?.listing,
    // Direct listing object from API
    () => (data?.id && (data?.name || data?.listing_name)) ? data : null,
  ];

  let raw = null;
  for (const tryGet of candidates) {
    try { raw = tryGet(); } catch (_) {}
    if (raw) break;
  }

  if (!raw) return null;

  // Normalise field names (Airbnb uses both camelCase and snake_case depending on version)
  const get = (...keys) => {
    for (const k of keys) {
      const v = k.split('.').reduce((obj, part) => obj?.[part], raw);
      if (v !== undefined && v !== null) return v;
    }
    return undefined;
  };

  const propertyTypeRaw = (get('property_type', 'propertyType', 'room_type', 'roomType', 'listing_type') || '').toLowerCase();
  const typeMap = {
    apartment: 'apartment', appartement: 'apartment',
    house: 'house', maison: 'house',
    villa: 'villa',
    studio: 'studio',
    loft: 'loft',
    chalet: 'chalet',
    cabin: 'chalet',
    'entire home': 'house', 'entire apartment': 'apartment',
    'private room': 'apartment', 'shared room': 'apartment'
  };
  const property_type = typeMap[propertyTypeRaw] || typeMap[Object.keys(typeMap).find(k => propertyTypeRaw.includes(k))] || 'apartment';

  // Collect ALL amenities from every known location in the response
  const allAmenities = [
    ...(get('listing_amenities', 'listingAmenities') || []),
    ...(get('pdp_listing_detail.pdp_listing_sections', 'pdpListingDetail.pdpListingSections') || [])
      .flatMap?.(s => [...(s?.amenities || []), ...(s?.seeAllAmenitiesGroups || []).flatMap(g => g?.amenities || [])]) || [],
    ...(get('sectionsInfo.sections') || [])
      .flatMap?.(s => [...(s?.amenities || []), ...(s?.seeAllAmenitiesGroups || []).flatMap(g => g?.amenities || [])]) || [],
  ];
  const amenityMapped = mapAmenities(allAmenities);

  // Full description: try composing from multiple text sections
  const descParts = [
    get('description', 'summary', 'listing_description', 'space'),
    get('transit', 'access'),
    get('neighborhood_overview', 'neighborhoodOverview'),
  ].filter(Boolean);
  const description = descParts.join('\n\n') || '';

  const house_rules = extractHouseRules(raw, get);
  const address     = extractAddress(raw, get);

  // Extraire check_in_time et check_out_time comme champs structurés séparés
  let check_in_time  = get('check_in_time', 'checkInTime', 'checkin_time') || '';
  let check_out_time = get('check_out_time', 'checkOutTime', 'checkout_time') || '';

  // Chercher également dans les sections PDP
  const allSections = [
    ...(get('pdp_listing_detail.pdp_listing_sections') || []),
    ...(get('pdpListingDetail.pdpListingSections') || []),
    ...(get('sectionsInfo.sections') || []),
  ];
  for (const section of allSections) {
    const type = (section?.sectionComponentType || section?.sectionType || '').toUpperCase();
    if (type.includes('AVAILABILITY') || type.includes('CHECKIN') || type.includes('CHECK_IN')) {
      check_in_time  = check_in_time  || section?.checkInTime  || section?.check_in_time  || '';
      check_out_time = check_out_time || section?.checkOutTime || section?.check_out_time || '';
    }
  }

  // Chercher dans la description/house_rules si encore vide
  if (!check_in_time) {
    const m = (house_rules + description).match(/check[-\s]?in[^:]*[:\s]+(\d{1,2}h?\d{0,2})/i)
           || (house_rules + description).match(/arriv[ée][e]?[^:]*[:\s]+(\d{1,2}h?\d{0,2})/i);
    if (m) check_in_time = m[1];
  }
  if (!check_out_time) {
    const m = (house_rules + description).match(/check[-\s]?out[^:]*[:\s]+(\d{1,2}h?\d{0,2})/i)
           || (house_rules + description).match(/d[ée]part[^:]*[:\s]+(\d{1,2}h?\d{0,2})/i);
    if (m) check_out_time = m[1];
  }

  // Infos de proximité / quartier
  const nearby = get('neighborhood_overview', 'neighborhoodOverview', 'transit', 'access') || '';

  return {
    airbnb_listing_id: listingId,
    // Empty, never a synthesized "Logement Airbnb #<id>": an absent name must
    // stay absent so the title resolver can look elsewhere and, failing that,
    // ask the user. Manufacturing a placeholder here is what made it look like
    // a real value all the way down to the INSERT.
    name: get('name', 'listing_name', 'listingName') || '',
    property_type,
    bedrooms:   Math.max(0, parseInt(get('bedrooms', 'bedroom_count', 'bedroomCount') || 1, 10)),
    beds:       Math.max(1, parseInt(get('beds', 'bed_count', 'bedCount') || 1, 10)),
    bathrooms:  Math.max(0, parseFloat(get('bathrooms', 'bathroom_count', 'bathroomCount') || 1)),
    max_guests: Math.max(1, parseInt(get('person_capacity', 'personCapacity', 'max_guests', 'guest_capacity') || 2, 10)),
    address,
    description,
    house_rules,
    check_in_time,
    check_out_time,
    nearby,
    ...amenityMapped,
    allows_pets:    allAmenities.some(a => (a.name || a.title || '').toLowerCase().includes('pet')) ||
                    (house_rules + description).toLowerCase().includes('animaux'),
    allows_smoking: allAmenities.some(a => (a.name || a.title || '').toLowerCase().includes('smok')) ||
                    (house_rules).toLowerCase().includes('fumeur') || (house_rules).toLowerCase().includes('smoking'),
    allows_events:  (house_rules).toLowerCase().includes('event') || (house_rules).toLowerCase().includes('fête') || (house_rules).toLowerCase().includes('partie'),
    _source: 'airbnb_scraped',
    _confidence: 'high'
  };
}

/**
 * Parse JSON-LD (Schema.org) structured data from Airbnb HTML.
 * Airbnb embeds LodgingBusiness / Product markup for SEO.
 */
function parseJsonLd(html, listingId) {
  const jsonLdBlocks = Array.from(
    html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi),
    m => m[1]
  );

  for (const block of jsonLdBlocks) {
    try {
      const data = JSON.parse(block);
      const items = Array.isArray(data) ? data : [data];

      for (const item of items) {
        const type = (item['@type'] || '').toLowerCase();
        if (!type) continue;
        // Accept any accommodation-related schema type
        const relevant = ['lodging', 'house', 'apartment', 'accommodation',
          'product', 'place', 'hotel', 'vacation', 'bnb', 'rental'].some(k => type.includes(k));
        if (!relevant) continue;

        const name = (item.name || item.headline || '').replace(/ [-|] Airbnb$/i, '').trim();
        if (!name) continue;

        const description = item.description || '';
        const address = typeof item.address === 'string' ? item.address :
          [item.address?.streetAddress, item.address?.addressLocality,
            item.address?.addressRegion, item.address?.addressCountry].filter(Boolean).join(', ');

        const bedrooms  = parseInt(item.numberOfBedrooms || item.numberOfRooms || 1, 10);
        const beds       = parseInt(item.numberOfBeds || bedrooms || 1, 10);
        const maxGuests  = parseInt(item.occupancy?.maxValue || item.numberOfGuests || 2, 10);
        const bathrooms  = parseFloat(item.numberOfBathroomsTotal || item.numberOfBathrooms || 1);

        // Amenities from amenityFeature
        const amenityList = [];
        if (Array.isArray(item.amenityFeature)) {
          for (const a of item.amenityFeature) {
            if (a.name) amenityList.push({ name: a.name });
            if (a.value && typeof a.value === 'string') amenityList.push({ name: a.value });
          }
        }
        const amenityMapped = mapAmenities(amenityList);

        const propertyTypeRaw = (type + ' ' + name + ' ' + description).toLowerCase();
        const ptMap = { villa: 'villa', maison: 'house', house: 'house', chalet: 'chalet',
          cabin: 'chalet', studio: 'studio', loft: 'loft', apartment: 'apartment', appartement: 'apartment' };
        let property_type = 'apartment';
        for (const [kw, val] of Object.entries(ptMap)) {
          if (propertyTypeRaw.includes(kw)) { property_type = val; break; }
        }

        return {
          airbnb_listing_id: listingId, name, property_type,
          bedrooms: Math.max(0, bedrooms), beds: Math.max(1, beds),
          bathrooms: Math.max(0, bathrooms), max_guests: Math.max(1, maxGuests),
          address, description, house_rules: '',
          check_in_time: item.checkinTime || '', check_out_time: item.checkoutTime || '',
          nearby: '', ...amenityMapped,
          allows_pets: false, allows_smoking: false, allows_events: false,
          _source: 'json_ld', _confidence: 'medium'
        };
      }
    } catch (_) {}
  }
  return null;
}

/**
 * Parse Airbnb's newer data-deferred-state / data-state script embeddings.
 * Airbnb now uses these instead of (or in addition to) __NEXT_DATA__.
 */
function parseDeferredState(html, listingId) {
  // data-deferred-state scripts
  const deferredMatches = Array.from(
    html.matchAll(/<script[^>]*data-deferred-state[^>]*>([\s\S]*?)<\/script>/gi),
    m => m[1]
  );
  // Also try data-state scripts
  const stateMatches = Array.from(
    html.matchAll(/<script[^>]*data-state[^>]*>([\s\S]*?)<\/script>/gi),
    m => m[1]
  );
  // Also niobeMinimalClientData (newer Airbnb embeds)
  const niobeMatch = html.match(/"niobeMinimalClientData"\s*:\s*(\[\[.*?\]\])/s);

  const candidates = [...deferredMatches, ...stateMatches];
  if (niobeMatch) candidates.push(niobeMatch[1]);

  for (const blob of candidates) {
    try {
      const data = JSON.parse(blob);
      // Recursively search for listing data in the parsed object
      const listing = findListingInObject(data, listingId, 4);
      if (listing) {
        const parsed = parseListing({ listing }, listingId) || parseListing(listing, listingId);
        if (parsed && parsed.name && !parsed.name.includes('#' + listingId)) {
          parsed._source = 'deferred_state';
          return parsed;
        }
      }
    } catch (_) {}
  }
  return null;
}

/**
 * Recursively search an object for something that looks like listing data
 */
function findListingInObject(obj, listingId, maxDepth) {
  if (!obj || typeof obj !== 'object' || maxDepth <= 0) return null;
  // Check if this object itself looks like a listing
  if (obj.name && (obj.bedrooms || obj.bedroom_count || obj.person_capacity || obj.personCapacity)) {
    return obj;
  }
  // Check for listing nested under common keys
  for (const key of ['listing', 'pdpListing', 'pdp_listing_detail', 'listingInfo', 'stayListing']) {
    if (obj[key] && typeof obj[key] === 'object') {
      const found = findListingInObject(obj[key], listingId, maxDepth - 1);
      if (found) return found;
    }
  }
  // Array traversal
  if (Array.isArray(obj)) {
    for (const item of obj.slice(0, 20)) {
      const found = findListingInObject(item, listingId, maxDepth - 1);
      if (found) return found;
    }
  } else {
    // Traverse object values
    for (const val of Object.values(obj).slice(0, 30)) {
      if (val && typeof val === 'object') {
        const found = findListingInObject(val, listingId, maxDepth - 1);
        if (found) return found;
      }
    }
  }
  return null;
}

/**
 * Parse OG/meta tags as last-resort fallback — enriched to extract
 * bedroom/bed/bath/guest counts from the description text.
 */
function parseMetaTags(html, listingId) {
  const og = (prop) => {
    const m = html.match(new RegExp(`<meta[^>]*property=["']og:${prop}["'][^>]*content=["']([^"']+)["']`, 'i'))
              || html.match(new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:${prop}["']`, 'i'));
    return m ? m[1] : '';
  };
  // Also check standard meta name tags
  const metaName = (name) => {
    const m = html.match(new RegExp(`<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']+)["']`, 'i'));
    return m ? m[1] : '';
  };

  // NOT og:site_name — on every Airbnb page that meta is the literal string
  // "Airbnb", so including it here produced listings actually named "Airbnb".
  const title = og('title') || metaName('title') || '';
  const desc = og('description') || metaName('description') || '';

  // Try to extract counts from description like "2 guests · 1 bedroom · 1 bed · 1 bath"
  // or French: "2 voyageurs · 1 chambre · 1 lit · 1 salle de bain"
  const descLower = desc.toLowerCase();
  const extractNum = (patterns) => {
    for (const p of patterns) {
      const m = descLower.match(p);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  };

  const bedrooms = extractNum([/(\d+)\s*(?:bedroom|chambre|ch\.)/i]) || 1;
  const beds = extractNum([/(\d+)\s*(?:bed(?!room)|lit(?!s?\s*de))/i]) || bedrooms || 1;
  const bathrooms = extractNum([/(\d+(?:\.\d+)?)\s*(?:bath|salle|sdb)/i]) || 1;
  const maxGuests = extractNum([/(\d+)\s*(?:guest|voyageur|person|traveler)/i]) || 2;

  // Try to extract address from meta or page title
  const address = metaName('geo.placename') || metaName('geo.region') || '';

  // Parse property type from title/description
  const combined = (title + ' ' + desc).toLowerCase();
  const ptMap = { villa: 'villa', maison: 'house', house: 'house', chalet: 'chalet',
    cabin: 'chalet', studio: 'studio', loft: 'loft', gîte: 'house', gite: 'house',
    apartment: 'apartment', appartement: 'apartment' };
  let property_type = 'apartment';
  for (const [kw, val] of Object.entries(ptMap)) {
    if (combined.includes(kw)) { property_type = val; break; }
  }

  return {
    airbnb_listing_id: listingId,
    // Suffix stripping is handled centrally by cleanListingTitle(); leaving it
    // empty here lets the resolver decide, rather than inventing "Logement #<id>".
    name: cleanListingTitle(title) || '',
    property_type,
    bedrooms, beds, bathrooms, max_guests: maxGuests,
    description: desc,
    address, house_rules: '',
    has_wifi: false, has_kitchen: false, has_parking: false, has_pool: false,
    has_gym: false, has_tv: false, has_washing_machine: false, has_air_conditioning: false,
    has_heating: false, has_workspace: false, has_hair_dryer: false, has_iron: false,
    has_bathtub: false, has_dryer: false, has_dishwasher: false, has_microwave: false,
    has_refrigerator: false, has_coffee_maker: false, has_smoke_detector: false,
    has_carbon_monoxide_detector: false, has_fire_extinguisher: false, has_first_aid_kit: false,
    has_bbq: false, has_terrace: false, has_garden: false, has_netflix: false, has_fireplace: false,
    allows_pets: false, allows_smoking: false, allows_events: false,
    _source: 'meta_tags',
    _confidence: 'low'
  };
}

/**
 * POST /api/properties/import-airbnb
 * Body: { url: "https://airbnb.com/rooms/12345678" }
 * Returns pre-filled property data the frontend can use to populate the creation form
 */
async function importAirbnbListing(req, res) {
  const { url } = req.body || {};

  if (!url) {
    return res.status(400).json({ error: 'URL ou identifiant Airbnb requis' });
  }

  // Reject anything that is not an Airbnb link before touching the network.
  // A bare numeric id stays valid (it never becomes a request to a foreign host).
  const looksLikeBareId = /^\d{4,}$/.test(String(url).trim());
  if (!looksLikeBareId) {
    const urlCheck = validateAirbnbUrl(url);
    if (!urlCheck.valid) {
      return res.status(400).json({ error: `Lien Airbnb invalide : ${urlCheck.reason}` });
    }
  }

  let listingId = extractListingId(url);

  // Short links (abnb.me/…, airbnb.app.link/…) carry no id — resolve them.
  if (!listingId && !looksLikeBareId) {
    try {
      const resolved = await resolveShortLink(url);
      if (resolved) {
        listingId = resolved.listingId;
        logger.info(`Airbnb short link resolved to listing ${listingId}`);
      }
    } catch (err) {
      logger.warn(`Short link resolution failed: ${err.message}`);
    }
  }

  if (!listingId) {
    return res.status(400).json({
      error: 'URL invalide. Format attendu : https://www.airbnb.com/rooms/12345678'
    });
  }

  logger.info(`Airbnb import attempt for listing ID: ${listingId}`);

  // Best parse so far. The API branch used to return immediately only when the
  // name was usable and otherwise threw the whole result away; now the data is
  // kept as a fallback while the HTML path tries to recover a real title.
  let bestParsed = null;
  let bestPhotos = [];

  // Strategy 0: Try Airbnb internal API (structured JSON, most reliable)
  try {
    const apiData = await fetchViaAirbnbApi(listingId);
    if (apiData) {
      const parsed = parseListing(apiData, listingId);
      if (parsed) {
        parsed._source = 'airbnb_api';
        parsed._confidence = 'high';
        bestParsed = parsed;
        bestPhotos = extractPhotos(apiData, '');
        if (isValidListingName(parsed.name, listingId)) {
          logger.info(`Airbnb import success via API for ${listingId}`);
          return sendImportResult(res, { parsed, listingId, photos: bestPhotos, html: '' });
        }
        logger.info(`Airbnb API returned data for ${listingId} but no usable name — trying HTML`);
      }
    }
  } catch (apiErr) {
    logger.warn(`Airbnb API strategy failed: ${apiErr.message}`);
  }

  // Try fetching the Airbnb listing page.
  // safeFetch pins the request to the Airbnb host allowlist, validates every
  // redirect hop, and caps both duration and response size.
  const targetUrl = `https://www.airbnb.com/rooms/${listingId}?check_in=2026-06-01&check_out=2026-06-05&adults=2`;
  let html = '';
  let fetchOk = false;

  const pageResult = await safeFetch(targetUrl, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Cache-Control': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Upgrade-Insecure-Requests': '1',
    },
  });

  if (pageResult.ok) {
    html = pageResult.body;
    fetchOk = html.length > 1000;
  } else {
    logger.warn(`Airbnb fetch failed for ${listingId}: ${pageResult.reason}`);
  }

  // Strategy 1: Parse __NEXT_DATA__ JSON blob
  if (fetchOk) {
    const nextDataRegex = /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;
    const match = html.match(nextDataRegex);
    if (match) {
      try {
        const nextData = JSON.parse(match[1]);
        const parsed = parseListing(nextData, listingId);
        if (parsed) {
          // This branch previously returned on `if (parsed)` alone, with no name
          // check at all — that is how "Logement Airbnb #<id>" reached the DB
          // whenever the blob parsed but carried no title. sendImportResult now
          // re-derives the name from the page and refuses placeholders.
          logger.info(`Airbnb import success via __NEXT_DATA__ for ${listingId}`);
          const ndPhotos = extractPhotos(nextData, html);
          if (!bestParsed || isValidListingName(parsed.name, listingId)) {
            bestParsed = parsed;
            bestPhotos = ndPhotos.length ? ndPhotos : bestPhotos;
          }
          const titled = resolveListingTitle({ html, listingId, parsedName: parsed.name });
          if (titled.name) {
            return sendImportResult(res, { parsed, listingId, photos: ndPhotos, html });
          }
        }
      } catch (parseErr) {
        logger.warn(`__NEXT_DATA__ parse error: ${parseErr.message}`);
      }
    }

    // Strategy 2: Try any other large JSON blobs containing listing data
    const jsonBlobs = Array.from(html.matchAll(/<script[^>]*>([\s\S]{500,}?)<\/script>/gi), m => m[1]);
    for (const blob of jsonBlobs.slice(0, 10)) {
      try {
        const d = JSON.parse(blob);
        const parsed = parseListing(d, listingId);
        if (parsed && isValidListingName(parsed.name, listingId)) {
          logger.info(`Airbnb import success via JSON blob for ${listingId}`);
          const blobPhotos = extractPhotos(d, html);
          return sendImportResult(res, { parsed, listingId, photos: blobPhotos, html });
        }
      } catch (_) {}
    }

    // Strategy 2b: Try data-deferred-state / data-state scripts (newer Airbnb)
    const deferredParsed = parseDeferredState(html, listingId);
    if (deferredParsed && isValidListingName(deferredParsed.name, listingId)) {
      logger.info(`Airbnb import success via deferred-state for ${listingId}`);
      const defPhotos = extractPhotos({}, html);
      return sendImportResult(res, { parsed: deferredParsed, listingId, photos: defPhotos, html });
    }

    // Strategy 2c: Try JSON-LD Schema.org structured data
    const jsonLdParsed = parseJsonLd(html, listingId);
    if (jsonLdParsed && isValidListingName(jsonLdParsed.name, listingId)) {
      logger.info(`Airbnb import success via JSON-LD for ${listingId}`);
      const ldPhotos = extractPhotos({}, html);
      return sendImportResult(res, { parsed: jsonLdParsed, listingId, photos: ldPhotos, html });
    }

    // Strategy 3: Meta tags fallback (enriched — extracts counts from description)
    const metaParsed = parseMetaTags(html, listingId);
    if (metaParsed) {
      const metaPhotos = extractPhotos({}, html);
      if (!bestParsed) {
        bestParsed = metaParsed;
        if (metaPhotos.length) bestPhotos = metaPhotos;
      }
      // Only ship it if a real title can be resolved from the page; the old
      // check let `og:site_name` ("Airbnb") through as the listing name.
      const titled = resolveListingTitle({ html, listingId, parsedName: metaParsed.name });
      if (titled.name) {
        logger.info(`Airbnb import via meta tags for ${listingId}`);
        return sendImportResult(res, { parsed: metaParsed, listingId, photos: metaPhotos, html });
      }
    }
  }

  // Strategy 4: nothing usable. Ship whatever structured data we did gather
  // (the API branch often has everything except a title) and let
  // sendImportResult flag the name for confirmation.
  logger.warn(`Airbnb import could not resolve a title for listing ${listingId}`);

  const fallbackParsed = bestParsed || {
    airbnb_listing_id: listingId,
    name: '',
    property_type: 'apartment',
    bedrooms: 1, beds: 1, bathrooms: 1, max_guests: 2,
    description: '', address: '', house_rules: '',
    has_wifi: true, has_kitchen: false, has_parking: false, has_pool: false,
    has_gym: false, has_tv: false, has_washing_machine: false, has_air_conditioning: false,
    has_heating: true, has_workspace: false, has_hair_dryer: false, has_iron: false,
    allows_pets: false, allows_smoking: false, allows_events: false,
    _source: 'stub',
    _confidence: 'none'
  };

  return sendImportResult(res, {
    parsed: fallbackParsed,
    listingId,
    photos: bestPhotos,
    html,
    warning: "Airbnb n'a pas laissé récupérer le nom de l'annonce. Vérifiez ou saisissez-le avant de créer le logement.",
  });
}

/**
 * Single exit point for every import strategy.
 *
 * Re-derives the listing name from the page (JSON-LD → Open Graph → <title> →
 * data already parsed) and refuses to emit a placeholder. When no reliable name
 * exists the payload carries `needs_name_confirmation: true` and an empty
 * `name`, which the client turns into a required, pre-filled field — nothing is
 * ever silently saved as "Logement Airbnb #<id>".
 */
function sendImportResult(res, { parsed, listingId, photos = [], html = '', scanName = null, warning = null }) {
  const data = { ...parsed };

  const titled = resolveListingTitle({
    html,
    listingId,
    parsedName: data.name,
    scanName,
  });

  if (titled.name) {
    data.name = titled.name;
    data._name_source = titled.source;
    data._name_confirmed = false;
  } else {
    // Never hand the client a name it might save verbatim.
    data.name = '';
    data._name_source = 'none';
  }

  const needsConfirmation = !titled.name;

  return res.json({
    success: true,
    data,
    listing_id: listingId,
    photos,
    needs_name_confirmation: needsConfirmation,
    suggested_name: titled.name || '',
    ...(warning || needsConfirmation
      ? { warning: warning || "Le nom de l'annonce n'a pas pu être récupéré. Merci de le saisir." }
      : {}),
  });
}

/**
 * POST /api/properties/scan-airbnb-profile
 * Body: { profileUrl: "https://www.airbnb.fr/users/show/12345678" }
 * Returns all listing IDs found on the host's public profile page
 */
async function scanAirbnbProfile(req, res) {
  const { profileUrl } = req.body || {};
  if (!profileUrl || typeof profileUrl !== 'string') {
    return res.status(400).json({ error: "URL de profil Airbnb requise" });
  }

  let url = profileUrl.trim();
  // Accept bare user IDs
  if (/^\d+$/.test(url)) url = `https://www.airbnb.com/users/show/${url}`;
  if (!url.startsWith('http')) url = 'https://' + url;

  // SSRF protection. The previous check only blocked private/internal hosts,
  // so ANY public URL was fetchable through this authenticated endpoint —
  // effectively a request proxy. Now the host must be Airbnb, every redirect
  // hop is re-validated, and the response is bounded in time and size.
  const urlCheck = validateAirbnbUrl(url);
  if (!urlCheck.valid) {
    return res.status(400).json({ error: `URL invalide: ${urlCheck.reason}` });
  }
  url = urlCheck.url;

  logger.info(`Airbnb profile scan: ${url}`);

  const scanResult = await safeFetch(url, {
    timeoutMs: 15000,
    headers: { 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Cache-Control': 'no-cache' },
  });
  const html = scanResult.ok ? scanResult.body : '';
  if (!scanResult.ok) {
    logger.warn(`Profile scan fetch error: ${scanResult.reason}`);
  }

  if (!html || html.length < 500) {
    return res.status(502).json({
      error: "Impossible de charger ce profil Airbnb. Vérifiez l'URL et réessayez."
    });
  }

  // Extract all unique listing IDs from /rooms/ href patterns
  const listingIds = [...new Set(
    Array.from(html.matchAll(/\/rooms\/(\d{6,})/g), m => m[1])
  )].slice(0, 30);

  if (listingIds.length === 0) {
    return res.status(404).json({
      error: "Aucun logement trouvé sur cette page. Vérifiez que l'URL est celle de votre profil hôte public Airbnb."
    });
  }

  // Try to extract listing names from __NEXT_DATA__
  const listingNames = {};
  try {
    const match = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (match) {
      const nextData = JSON.parse(match[1]);
      const listingsArr =
        nextData?.props?.pageProps?.hostProfile?.listings ||
        nextData?.props?.pageProps?.listings ||
        nextData?.props?.pageProps?.bootstrapData?.reduxData?.userProfile?.listings ||
        [];
      for (const l of listingsArr) {
        const id = String(l.id || l.listing_id || '');
        const name = l.name || l.listing_name || l.title || '';
        if (id && name) listingNames[id] = name;
      }
    }
  } catch (_) {}

  const listings = listingIds.map(id => ({
    id,
    name: listingNames[id] || null
  }));

  logger.info(`Airbnb profile scan: ${listings.length} listings found`);
  return res.json({ success: true, listings, total: listings.length });
}

// ─── Photo extraction ────────────────────────────────────────────────────────

/**
 * Extract photos from Airbnb API data or parsed HTML blobs.
 * Returns array of { url, position, alt }.
 */
function extractPhotos(rawData, html = '') {
  const photos = [];
  const seen = new Set();

  const addPhoto = (url, position, alt = '') => {
    if (!url || typeof url !== 'string') return;
    // Normalise CDN URL — strip size suffix so we can request larger version
    const clean = url.replace(/\?.*$/, '').replace(/_[a-z]\.\w+$/, '');
    const base = clean || url;
    if (seen.has(base)) return;
    seen.add(base);
    photos.push({ url, position, alt: alt || '' });
  };

  // --- Strategy 1: Airbnb API response (pdp_listing_detail or listing)
  const tryObj = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    // Photos directly on listing
    for (const key of ['photos', 'listing_photos', 'picture_urls', 'listingPhotos']) {
      const arr = obj[key];
      if (Array.isArray(arr)) {
        arr.forEach((p, i) => {
          const url = p?.large_url || p?.picture?.large || p?.picture?.url || p?.url || p?.baseUrl || (typeof p === 'string' ? p : null);
          const alt = p?.caption || p?.picture?.caption || '';
          addPhoto(url, i, alt);
        });
      }
    }
    // xl_picture_url / picture_url single fields
    for (const key of ['xl_picture_url', 'picture_url', 'listingThumbnailUrl', 'thumbnail_url']) {
      if (obj[key]) addPhoto(obj[key], photos.length, '');
    }
    // Nested pdp_listing_detail.photos
    if (obj.pdp_listing_detail?.photos) tryObj({ photos: obj.pdp_listing_detail.photos });
    if (obj.listing?.photos) tryObj({ photos: obj.listing.photos });
  };

  if (rawData) tryObj(rawData);

  // --- Strategy 2: __NEXT_DATA__ / JSON blobs in HTML
  if (html && photos.length < 3) {
    const blobs = [
      ...Array.from(html.matchAll(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi), m => m[1]),
      ...Array.from(html.matchAll(/<script[^>]*>([\s\S]{1000,}?)<\/script>/gi), m => m[1]).slice(0, 5),
    ];
    for (const blob of blobs) {
      try {
        const data = JSON.parse(blob);
        // Deep search for photo arrays
        const findPhotos = (obj, depth = 0) => {
          if (!obj || typeof obj !== 'object' || depth > 5) return;
          for (const key of ['photos', 'listing_photos', 'picture_urls', 'listingPhotos']) {
            if (Array.isArray(obj[key])) {
              obj[key].forEach((p, i) => {
                const url = p?.large_url || p?.picture?.large || p?.url || p?.baseUrl || (typeof p === 'string' ? p : null);
                addPhoto(url, photos.length + i, p?.caption || '');
              });
            }
          }
          if (Array.isArray(obj)) obj.slice(0, 30).forEach(v => findPhotos(v, depth + 1));
          else Object.values(obj).slice(0, 20).forEach(v => findPhotos(v, depth + 1));
        };
        findPhotos(data);
        if (photos.length >= 3) break;
      } catch (_) {}
    }
  }

  // --- Strategy 3: og:image meta tag (last resort — single photo)
  if (html && photos.length === 0) {
    const m = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
    if (m && m[1]) addPhoto(m[1], 0, 'Photo principale');
  }

  // Re-index positions
  return photos.slice(0, 25).map((p, i) => ({ ...p, position: i, is_main: i === 0 }));
}

// ─── Confirm import ──────────────────────────────────────────────────────────

/**
 * POST /api/properties/confirm-import
 * Saves the previewed property + photos to the DB for the authenticated user.
 * Anti-doublon : if user_id + airbnb_listing_id already exists, returns alreadyExists.
 */
async function confirmImport(req, res) {
  const { getDatabase } = require('../config/db');
  const db = getDatabase();
  const userId = req.userId;
  const body = req.body || {};

  const {
    airbnb_listing_id,
    name, property_type, bedrooms, beds, bathrooms, max_guests,
    address, description, house_rules, check_in_time, check_out_time, nearby,
    source_url, city, country, rating, review_count,
    photos = [],
    // amenities
    has_wifi, has_kitchen, has_parking, has_pool, has_gym, has_tv,
    has_washing_machine, has_air_conditioning, has_heating, has_workspace,
    has_hair_dryer, has_iron, has_bathtub, has_dryer, has_dishwasher,
    has_microwave, has_refrigerator, has_coffee_maker, has_smoke_detector,
    has_carbon_monoxide_detector, has_fire_extinguisher, has_first_aid_kit,
    has_bbq, has_terrace, has_garden, has_netflix, has_fireplace,
    allows_pets, allows_smoking, allows_events,
    auto_reply_enabled, reply_tone,
  } = body;

  if (!name) return res.status(400).json({ error: 'Le nom du logement est requis.' });

  // Server-side guard: even if an old client (or a direct API call) sends the
  // legacy placeholder, it must never reach the database. This is the last line
  // of defence behind the resolver — clients can be stale, the DB cannot.
  const cleanName = String(name).trim();
  if (isPlaceholderName(cleanName, airbnb_listing_id)) {
    return res.status(400).json({
      error: "Merci de saisir le vrai nom de l'annonce (le nom automatique n'est pas accepté).",
      needs_name_confirmation: true,
    });
  }

  // ── Anti-doublon ────────────────────────────────────────────────────────
  if (airbnb_listing_id) {
    const existing = await db.query(
      'SELECT id FROM property_profiles WHERE user_id = ? AND airbnb_listing_id = ?',
      [userId, String(airbnb_listing_id)]
    );
    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        alreadyExists: true,
        existingId: existing[0].id,
        message: 'Ce logement Airbnb existe déjà sur votre compte. Voulez-vous le mettre à jour ?'
      });
    }
  }

  // ── Première photo comme main_photo_url ──────────────────────────────────
  const mainPhoto = photos.find(p => p.is_main) || photos[0] || null;

  try {
    // ── Insérer le logement ───────────────────────────────────────────────
    const result = await db.query(
      `INSERT INTO property_profiles
        (user_id, source, source_url, airbnb_listing_id,
         name, property_type, bedrooms, beds, bathrooms, max_guests,
         address, description, house_rules, check_in_time, check_out_time, nearby,
         city, country, rating, review_count, main_photo_url,
         has_wifi, has_kitchen, has_parking, has_pool, has_gym, has_tv,
         has_washing_machine, has_air_conditioning, has_heating, has_workspace,
         has_hair_dryer, has_iron, has_bathtub, has_dryer, has_dishwasher,
         has_microwave, has_refrigerator, has_coffee_maker, has_smoke_detector,
         has_carbon_monoxide_detector, has_fire_extinguisher, has_first_aid_kit,
         has_bbq, has_terrace, has_garden, has_netflix, has_fireplace,
         allows_pets, allows_smoking, allows_events,
         auto_reply_enabled, reply_tone)
       VALUES
        (?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?, ?,
         ?, ?)`,
      [
        userId, 'airbnb', source_url || null, airbnb_listing_id || null,
        cleanName, property_type || 'apartment',
        parseInt(bedrooms) || 1, parseInt(beds) || 1,
        parseFloat(bathrooms) || 1, parseInt(max_guests) || 2,
        address || '', description || '', house_rules || '',
        check_in_time || '', check_out_time || '', nearby || '',
        city || null, country || null,
        rating ? parseFloat(rating) : null,
        review_count ? parseInt(review_count) : 0,
        mainPhoto ? mainPhoto.url : null,
        has_wifi ? 1 : 0, has_kitchen ? 1 : 0, has_parking ? 1 : 0,
        has_pool ? 1 : 0, has_gym ? 1 : 0, has_tv ? 1 : 0,
        has_washing_machine ? 1 : 0, has_air_conditioning ? 1 : 0,
        has_heating ? 1 : 0, has_workspace ? 1 : 0,
        has_hair_dryer ? 1 : 0, has_iron ? 1 : 0,
        has_bathtub ? 1 : 0, has_dryer ? 1 : 0, has_dishwasher ? 1 : 0,
        has_microwave ? 1 : 0, has_refrigerator ? 1 : 0,
        has_coffee_maker ? 1 : 0, has_smoke_detector ? 1 : 0,
        has_carbon_monoxide_detector ? 1 : 0,
        has_fire_extinguisher ? 1 : 0, has_first_aid_kit ? 1 : 0,
        has_bbq ? 1 : 0, has_terrace ? 1 : 0, has_garden ? 1 : 0,
        has_netflix ? 1 : 0, has_fireplace ? 1 : 0,
        allows_pets ? 1 : 0, allows_smoking ? 1 : 0, allows_events ? 1 : 0,
        auto_reply_enabled ? 1 : 0, reply_tone || 'friendly',
      ]
    );

    const propertyId = result.insertId;

    // Record where the name came from. A re-scan may later correct an
    // automatically-extracted name, but must never overwrite one the user typed
    // or confirmed themselves (see updateFromAirbnb). Written separately rather
    // than threaded through the 50-placeholder INSERT above.
    const nameSource = body.name_confirmed_by_user ? 'manual' : 'airbnb_auto';
    await db.query(
      'UPDATE property_profiles SET name_source = ? WHERE id = ? AND user_id = ?',
      [nameSource, propertyId, userId]
    );

    // ── Insérer les photos ────────────────────────────────────────────────
    if (photos.length > 0) {
      for (const photo of photos.slice(0, 25)) {
        if (!photo.url) continue;
        await db.query(
          `INSERT INTO property_photos
            (property_id, user_id, source, source_url, image_url, position, alt, is_main)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            propertyId, userId,
            photo.source || 'airbnb',
            photo.source_url || photo.url,
            photo.url,
            photo.position || 0,
            photo.alt || '',
            photo.is_main ? 1 : 0,
          ]
        );
      }
    }

    logger.info(`Property imported: id=${propertyId} user=${userId} airbnb=${airbnb_listing_id}`);
    return res.status(201).json({
      success: true,
      propertyId,
      message: 'Logement importé avec succès.',
    });
  } catch (err) {
    logger.error('confirmImport error:', err.message);
    return res.status(500).json({ error: 'Erreur lors de la sauvegarde du logement.' });
  }
}

// ─── Update from Airbnb ──────────────────────────────────────────────────────

/**
 * PUT /api/properties/:id/update-from-airbnb
 * Re-fetches Airbnb data and updates the property (ownership enforced).
 */
async function updateFromAirbnb(req, res) {
  const { getDatabase } = require('../config/db');
  const db = getDatabase();
  const userId = req.userId;
  const propertyId = parseInt(req.params.id, 10);

  // Ownership check
  const props = await db.query(
    'SELECT id, name, name_source, airbnb_listing_id FROM property_profiles WHERE id = ? AND user_id = ?',
    [propertyId, userId]
  );
  if (!props.length) return res.status(403).json({ error: 'Accès refusé ou logement introuvable.' });

  const current = props[0];
  const listingId = current.airbnb_listing_id;
  if (!listingId) return res.status(400).json({ error: "Ce logement n'a pas d'identifiant Airbnb." });

  // Re-fetch: API first, then the public page — the page is what carries
  // JSON-LD/OG/<title>, which is where a real name usually comes from when the
  // API answer has none.
  let parsed = null;
  try {
    const apiData = await fetchViaAirbnbApi(listingId);
    if (apiData) parsed = parseListing(apiData, listingId);
  } catch (_) {}

  let html = '';
  const pageResult = await safeFetch(`https://www.airbnb.com/rooms/${listingId}`, {
    headers: { 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
  });
  if (pageResult.ok) html = pageResult.body;

  if (!parsed && html) {
    parsed = parseJsonLd(html, listingId) || parseDeferredState(html, listingId) || parseMetaTags(html, listingId);
  }

  if (!parsed) return res.status(502).json({ error: "Impossible de récupérer les données Airbnb. Réessayez plus tard." });

  // ── Name handling ────────────────────────────────────────────────────────
  // A name the user typed or confirmed is theirs — a re-scan never overwrites
  // it. Anything auto-generated (including the legacy "Logement Airbnb #<id>"
  // placeholder still sitting in older rows) IS corrected when a real title can
  // be resolved. Nothing here creates a row, so re-scanning cannot duplicate.
  const titled = resolveListingTitle({ html, listingId, parsedName: parsed.name });
  const userOwnsName = current.name_source === 'manual';
  const currentIsPlaceholder = isPlaceholderName(current.name, listingId);

  let nextName = current.name;
  let nameUpdated = false;
  if (!userOwnsName && titled.name && titled.name !== current.name) {
    nextName = titled.name;
    nameUpdated = true;
  } else if (userOwnsName && currentIsPlaceholder && titled.name) {
    // Edge case: flagged manual but still holding the placeholder (e.g. saved
    // before this fix). A placeholder is not a name worth protecting.
    nextName = titled.name;
    nameUpdated = true;
  }

  try {
    await db.query(
      `UPDATE property_profiles SET
        name=?, name_source=?, description=?, house_rules=?, address=?,
        bedrooms=?, beds=?, bathrooms=?, max_guests=?,
        has_wifi=?, has_kitchen=?, has_parking=?, has_pool=?,
        has_air_conditioning=?, has_heating=?, has_tv=?,
        check_in_time=?, check_out_time=?
       WHERE id = ? AND user_id = ?`,
      [
        nextName,
        nameUpdated ? 'airbnb_auto' : (current.name_source || 'airbnb_auto'),
        parsed.description, parsed.house_rules, parsed.address,
        parsed.bedrooms, parsed.beds, parsed.bathrooms, parsed.max_guests,
        parsed.has_wifi ? 1 : 0, parsed.has_kitchen ? 1 : 0,
        parsed.has_parking ? 1 : 0, parsed.has_pool ? 1 : 0,
        parsed.has_air_conditioning ? 1 : 0, parsed.has_heating ? 1 : 0,
        parsed.has_tv ? 1 : 0,
        parsed.check_in_time || '', parsed.check_out_time || '',
        propertyId, userId,
      ]
    );
    logger.info(
      `Property ${propertyId} updated from Airbnb` +
      (nameUpdated ? ` (name corrected: "${current.name}" → "${nextName}")` : '')
    );
    return res.json({
      success: true,
      message: nameUpdated
        ? `Logement mis à jour. Nom corrigé : « ${nextName} ».`
        : 'Logement mis à jour depuis Airbnb.',
      name: nextName,
      name_updated: nameUpdated,
      name_locked: userOwnsName && !nameUpdated,
    });
  } catch (err) {
    logger.error('updateFromAirbnb error:', err.message);
    return res.status(500).json({ error: 'Erreur lors de la mise à jour.' });
  }
}

// ─── Photo management ────────────────────────────────────────────────────────

/**
 * GET /api/properties/:id/photos
 * Returns photos for a property (ownership enforced).
 */
async function getPropertyPhotos(req, res) {
  try {
    const { getDatabase } = require('../config/db');
    const db = getDatabase();
    const userId = req.userId;
    const propertyId = parseInt(req.params.id, 10);

    // Ownership check
    const props = await db.query(
      'SELECT id FROM property_profiles WHERE id = ? AND user_id = ?',
      [propertyId, userId]
    );
    if (!props.length) return res.status(403).json({ error: 'Accès refusé.' });

    const photos = await db.query(
      'SELECT * FROM property_photos WHERE property_id = ? AND user_id = ? ORDER BY position ASC',
      [propertyId, userId]
    );
    return res.json({ photos });
  } catch (err) {
    logger.error('Get property photos error:', err.message);
    return res.status(500).json({ error: 'Erreur lors du chargement des photos.' });
  }
}

/**
 * DELETE /api/properties/:id/photos/:photoId
 * Deletes a photo (ownership enforced on both property and photo).
 */
async function deletePropertyPhoto(req, res) {
  try {
    const { getDatabase } = require('../config/db');
    const db = getDatabase();
    const userId = req.userId;
    const propertyId = parseInt(req.params.id, 10);
    const photoId = parseInt(req.params.photoId, 10);

    const result = await db.query(
      'DELETE FROM property_photos WHERE id = ? AND property_id = ? AND user_id = ?',
      [photoId, propertyId, userId]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Photo introuvable.' });

    // La vignette du logement (property_profiles.main_photo_url) est un
    // raccourci dénormalisé : si on vient de supprimer la photo qu'elle
    // désignait, elle pointerait vers une image inexistante. On la recale sur
    // une photo encore présente, ou on la vide s'il n'en reste aucune.
    const remaining = await db.query(
      'SELECT image_url FROM property_photos WHERE property_id = ? AND user_id = ? ORDER BY is_main DESC, position ASC',
      [propertyId, userId]
    );
    const stillValid = remaining.map((p) => p.image_url);
    const current = await db.query(
      'SELECT main_photo_url FROM property_profiles WHERE id = ? AND user_id = ?',
      [propertyId, userId]
    );
    const currentUrl = current[0]?.main_photo_url || null;

    if (currentUrl && !stillValid.includes(currentUrl)) {
      await db.query(
        'UPDATE property_profiles SET main_photo_url = ? WHERE id = ? AND user_id = ?',
        [stillValid[0] || null, propertyId, userId]
      );
    }

    return res.json({ success: true });
  } catch (err) {
    logger.error('Delete property photo error:', err.message);
    return res.status(500).json({ error: 'Erreur lors de la suppression de la photo.' });
  }
}

/**
 * PUT /api/properties/:id/photos/:photoId/main
 * Sets a photo as the main photo for a property.
 */
async function setMainPhoto(req, res) {
  try {
    const { getDatabase } = require('../config/db');
    const db = getDatabase();
    const userId = req.userId;
    const propertyId = parseInt(req.params.id, 10);
    const photoId = parseInt(req.params.photoId, 10);

    // Ownership check
    const props = await db.query(
      'SELECT id FROM property_profiles WHERE id = ? AND user_id = ?',
      [propertyId, userId]
    );
    if (!props.length) return res.status(403).json({ error: 'Accès refusé.' });

    // Vérifier que la photo appartient bien à ce logement AVANT de toucher
    // aux drapeaux : sinon un id invalide effaçait la photo principale
    // existante sans jamais en désigner une nouvelle.
    const target = await db.query(
      'SELECT image_url FROM property_photos WHERE id = ? AND property_id = ? AND user_id = ?',
      [photoId, propertyId, userId]
    );
    if (!target.length) return res.status(404).json({ error: 'Photo introuvable.' });

    // Unset all, then set selected
    await db.query('UPDATE property_photos SET is_main = 0 WHERE property_id = ? AND user_id = ?', [propertyId, userId]);
    await db.query(
      'UPDATE property_photos SET is_main = 1 WHERE id = ? AND property_id = ? AND user_id = ?',
      [photoId, propertyId, userId]
    );

    await db.query(
      'UPDATE property_profiles SET main_photo_url = ? WHERE id = ? AND user_id = ?',
      [target[0].image_url, propertyId, userId]
    );

    return res.json({ success: true });
  } catch (err) {
    logger.error('Set main photo error:', err.message);
    return res.status(500).json({ error: 'Erreur lors de la mise à jour de la photo principale.' });
  }
}

module.exports = {
  importAirbnbListing,
  scanAirbnbProfile,
  confirmImport,
  updateFromAirbnb,
  getPropertyPhotos,
  deletePropertyPhoto,
  setMainPhoto,
  extractPhotos,
};

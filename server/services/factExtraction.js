/**
 * Extraction de FAITS CANDIDATS depuis le texte écrit par l'hôte.
 *
 * CE QUE CE MODULE FAIT, ET CE QU'IL NE FAIT PAS
 * ----------------------------------------------
 * Il rend des CANDIDATS : « cette phrase, écrite ce jour-là, dit que l'heure
 * d'arrivée est 16:00 ». Il ne décide jamais que 16:00 EST l'heure d'arrivée du
 * logement. Cette décision appartient à `factAggregation.js`, qui compte les
 * preuves, regarde leur étalement dans le temps et cherche les contradictions.
 *
 * Une phrase n'est donc jamais convertie directement en caractéristique. C'est
 * la règle qui protège du seul risque réel de cette source : une phrase de
 * conversation peut être une EXCEPTION accordée à un voyageur précis
 * (« exceptionnellement vous pouvez arriver à 14h ») et non la règle du
 * logement.
 *
 * TROIS FILTRES, DANS CET ORDRE
 * -----------------------------
 *   1. la phrase est-elle exploitable ? (pas une question, pas un incident) ;
 *   2. porte-t-elle un marqueur d'exception ou de mise à jour ? ;
 *   3. contient-elle une valeur littérale, reconnue par un motif écrit à la
 *      main pour CE champ ?
 *
 * Rien n'est deviné. Un champ sans valeur littérale reste vide : c'est la
 * consigne, et c'est aussi la seule position tenable — une heure d'arrivée
 * fausse coûte plus cher à un hôte qu'une heure absente.
 *
 * PORTÉE DE LA PHRASE
 * -------------------
 * Les marqueurs sont cherchés dans la PHRASE qui porte la valeur, pas dans le
 * message entier. Le message type de cet hôte commence par « merci d'avoir
 * choisi X pour votre séjour à Y » : chercher « pour votre séjour » dans tout
 * le message classerait en exception la totalité de ses arrivées.
 */

// ── Catégories de stabilité (§9 du cahier des charges) ──────────────────────
//
// Toutes les informations ne vieillissent pas à la même vitesse, et n'ont donc
// pas les mêmes exigences de preuve :
//
//   stable       l'étage, l'emplacement du parking, la boîte à clés. Ne change
//                pratiquement jamais : une forte répétition historique vaut.
//   semi_stable  les horaires, les règles. Change parfois : il faut une preuve
//                RÉCENTE, et l'absence de contradiction récente.
//   volatile     les codes et mots de passe. Peut avoir changé hier, sans que
//                rien dans l'historique ne le dise. N'atteint JAMAIS un statut
//                automatique : l'utilisateur confirme, ou le champ reste vide.
const STABILITY = {
  check_in_time: 'semi_stable',
  check_out_time: 'semi_stable',
  wifi_name: 'stable',
  wifi_password: 'volatile',
  access_code: 'volatile',
  gate_code: 'volatile',
  key_location: 'stable',
  parking_info: 'stable',
  trash_instructions: 'stable',
  building_entry: 'stable',
  floor_number: 'stable',
  has_elevator: 'stable',
  checkin_method: 'stable',
  allows_pets: 'semi_stable',
};

/** Type de la valeur produite, pour l'écriture en base et l'affichage. */
const VALUE_TYPE = {
  check_in_time: 'time',
  check_out_time: 'time',
  wifi_name: 'text',
  wifi_password: 'secret',
  access_code: 'secret',
  gate_code: 'secret',
  key_location: 'text',
  parking_info: 'text',
  trash_instructions: 'text',
  building_entry: 'text',
  floor_number: 'text',
  has_elevator: 'boolean',
  checkin_method: 'enum',
  allows_pets: 'boolean',
};

/** Libellés français, pour l'écran de vérification. */
const FACT_LABELS = {
  check_in_time: "Heure d'arrivée",
  check_out_time: 'Heure de départ',
  wifi_name: 'Nom du réseau Wi-Fi',
  wifi_password: 'Mot de passe Wi-Fi',
  access_code: 'Code de la boîte à clés',
  gate_code: 'Code du portail',
  key_location: 'Emplacement des clés',
  parking_info: 'Stationnement',
  trash_instructions: 'Poubelles et tri',
  building_entry: "Instructions d'entrée",
  floor_number: 'Étage',
  has_elevator: 'Ascenseur',
  checkin_method: "Méthode d'arrivée",
  allows_pets: 'Animaux acceptés',
};

const FACT_KEYS = Object.keys(STABILITY);

/**
 * Informations dont deux valeurs différentes se CONTREDISENT.
 *
 * Une heure d'arrivée, un code, un étage : il n'y en a qu'un, donc deux valeurs
 * observées signalent soit une erreur, soit un changement. C'est là que le
 * comptage des contradictions a un sens.
 *
 * Les champs libres, eux, ne sont pas exclusifs. « Vous arrivez sur le parking
 * du château » et « Les places de parking sont les 67 et 68 » disent deux
 * choses différentes du même stationnement, pas deux choses incompatibles. Les
 * compter comme des contradictions rendait instable TOUT champ libre, alors que
 * chacune des phrases était vraie et répétée sur des dizaines de séjours. La
 * plus fréquente est retenue, les autres sont présentées comme des variantes.
 */
const EXCLUSIVE_KEYS = new Set([
  'check_in_time', 'check_out_time', 'wifi_name', 'wifi_password',
  'access_code', 'gate_code', 'floor_number', 'has_elevator',
  'checkin_method', 'allows_pets',
]);

function isExclusive(key) {
  return EXCLUSIVE_KEYS.has(key);
}

// ── Découpage en phrases ────────────────────────────────────────────────────

// Un retour à la ligne sépare autant qu'un point : ces messages sont écrits en
// listes (« voici la procédure d'arrivée : » suivi d'une ligne par étape).
const SENTENCE_SPLIT = /\n+|(?<=[.!?;])\s+/;

const MAX_TEXT_LENGTH = 20000;
const MAX_SENTENCES = 120;

function sentences(text) {
  return String(text || '')
    .slice(0, MAX_TEXT_LENGTH)
    .split(SENTENCE_SPLIT)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 3)
    .slice(0, MAX_SENTENCES);
}

// ── Classification d'une phrase ─────────────────────────────────────────────

/**
 * Marqueurs d'EXCEPTION : la phrase décrit un arrangement pour CE voyageur, pas
 * la règle du logement. Le cas que ce projet doit absolument éviter.
 *
 * « pour votre séjour » n'y figure PAS, volontairement : la formule d'accueil
 * de cet hôte (« merci d'avoir choisi X pour votre séjour à Y ») la contient,
 * et l'inscrire ici reviendrait à jeter la moitié du corpus. Les marqueurs
 * retenus sont ceux qui ne peuvent rien vouloir dire d'autre.
 */
const EXCEPTION_MARKERS = [
  /exceptionnel/i,
  /pour cette fois/i,
  /juste cette fois/i,
  /pour votre r[ée]servation/i,
  /(?:à|a) titre (?:exceptionnel|gracieux|commercial)/i,
  /d[ée]rogation/i,
  /je (?:peux|pourrais|veux bien|vais) (?:vous )?(?:autoriser|accepter|faire|laisser|proposer|arranger|d[ée]caler|avancer)/i,
  /si vous (?:le )?souhaitez/i,
  /dans votre cas/i,
  /(?:uniquement|rien que) pour vous/i,
  /arrangement/i,
];

/**
 * Marqueurs de MISE À JOUR : l'hôte annonce que la règle a changé. Une preuve
 * ainsi marquée pèse beaucoup plus lourd qu'une ancienne occurrence, et suffit
 * à demander une confirmation à l'utilisateur.
 */
const UPDATE_MARKERS = [
  /d[ée]sormais/i,
  /dor[ée]navant/i,
  /(?:à|a) compter d[eu]/i,
  /(?:à|a) partir de maintenant/i,
  /nouveau code/i,
  /nouvelle heure/i,
  /(?:a|ont) chang[ée]/i,
  /remplac[ée] par/i,
  /n'est plus/i,
];

/**
 * Phrases dont on n'extrait RIEN, quoi qu'elles contiennent.
 *
 * Les incidents sont le piège explicite du cahier des charges : « le Wi-Fi ne
 * marche pas aujourd'hui » ne dit pas qu'il n'y a pas de Wi-Fi, et « le code
 * ne fonctionne plus » ne donne pas le nouveau code.
 */
const INCIDENT_MARKERS = [
  /ne (?:fonctionne|marche)(?: plus| pas)/i,
  /en panne/i,
  /hors service/i,
  /probl[èe]me (?:de|avec|sur)/i,
  /d[ée]sol[ée]/i,
  /d[ée]faillan/i,
];

/** Une question ne renseigne pas : elle demande. */
function isQuestion(sentence) {
  if (/\?/.test(sentence)) return true;
  return /^(?:(?:à|a) quelle heure|quelle est|quel est|pouvez[- ]vous|pourriez[- ]vous|est-ce que|avez[- ]vous|souhaitez[- ]vous)/i
    .test(sentence);
}

/**
 * @returns {'CONFIRMATION'|'EXCEPTION'|'UPDATE'|'AMBIGUOUS'}
 *
 * EXCEPTION et AMBIGUOUS ne comptent jamais comme preuve d'un fait permanent
 * (§7). L'exception est malgré tout renvoyée : son décompte explique pourquoi
 * une valeur bien présente dans les messages n'a pas été retenue.
 */
function classifySentence(sentence) {
  const text = String(sentence || '');
  if (!text.trim()) return 'AMBIGUOUS';
  if (isQuestion(text)) return 'AMBIGUOUS';
  if (INCIDENT_MARKERS.some((re) => re.test(text))) return 'AMBIGUOUS';
  if (EXCEPTION_MARKERS.some((re) => re.test(text))) return 'EXCEPTION';
  if (UPDATE_MARKERS.some((re) => re.test(text))) return 'UPDATE';
  return 'CONFIRMATION';
}

// ── Normalisation des heures ────────────────────────────────────────────────

// « 16h », « 16 h 30 », « 16:00 », « 10 heures », « 5:00 PM ». La minute est
// facultative ; l'indicateur AM/PM ne l'est pas quand il est là.
const TIME_TOKEN = /(\d{1,2})\s*(?:h(?:eures?)?|:)\s*(\d{2})?\s*(am|pm)?/i;

function normalizeTime(parts) {
  let hours = Number(parts[0]);
  const minutes = parts[1] === undefined || parts[1] === null ? 0 : Number(parts[1]);
  const meridiem = parts[2] ? String(parts[2]).toLowerCase() : null;

  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (minutes > 59) return null;

  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    if (meridiem === 'pm' && hours !== 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
  } else if (hours > 23) {
    return null;
  }

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * Un motif « ancre … connecteur … heure ».
 *
 * L'ancre nomme le sujet (arrivée, départ), le connecteur introduit l'heure.
 * L'écart entre les deux est borné et ne peut pas franchir une fin de phrase :
 * sans cela, « votre arrivée à Blanquefort … le départ est à 11h » ferait dire
 * 11h à l'arrivée.
 */
function timePattern(anchor, connector) {
  return new RegExp(
    `(?:${anchor})[^.\\n]{0,80}?(?:${connector})\\s*:?\\s*${TIME_TOKEN.source}`,
    'i'
  );
}

const CHECK_IN_ANCHOR = "arriv[ée]e?s?|check[ -]?in|checkin|d[ée]but du s[ée]jour";
const CHECK_OUT_ANCHOR = "d[ée]part|check[ -]?out|checkout|lib[ée]rer|quitter|rendre les cl[ée]s";
const TIME_CONNECTOR = "(?:à|a) partir de|d[èe]s|au plus t[ôo]t|avant|au plus tard|jusqu'(?:à|a)|est (?:pr[ée]vue?|fix[ée]e?)?\\s*(?:à|a)|se fait (?:à|a)|(?:à|a)|:";

// ── Extracteurs ─────────────────────────────────────────────────────────────
//
// Un extracteur = un champ + un motif + une normalisation. Il rend `null` dès
// que la valeur littérale manque : « Le code de la boîte à clé est » (sans
// chiffres, parce que l'hôte l'enverra plus tard) ne produit rien.

const CHECK_IN_RE = timePattern(CHECK_IN_ANCHOR, TIME_CONNECTOR);
const CHECK_OUT_RE = timePattern(CHECK_OUT_ANCHOR, TIME_CONNECTOR);

// Le nom du réseau : tout ce qui suit l'annonce du nom, jusqu'au mot de passe
// ou à la fin de la phrase. Le `\s*` avant « et » est indispensable — l'hôte
// écrit parfois « Livebox-DF50et le mot de passe », sans espace.
const WIFI_PAIR_RE =
  /(?:nom (?:du|de) (?:r[ée]seau )?wi-?fi(?: est)?|r[ée]seau wi-?fi(?: est)?|wi-?fi(?: est)?)\s*:?\s*(.{1,60}?)\s*(?:et\s*(?:voici\s*)?(?:le\s*)?mot de passe|,?\s*mot de passe|$)/i;
const WIFI_PASSWORD_RE =
  /mot de passe(?:\s*(?:du|de la|wi-?fi|r[ée]seau))*\s*(?:est)?\s*:?\s*([^\s].{0,48}?)\s*$/i;

// Mots de liaison : leur présence signe une phrase, pas un identifiant de
// réseau. « Le WiFi est dans le salon » ne donne aucun nom de réseau.
const PROSE_RE = /(?:^|\s)(?:pas|plus|ne|n'|est|sont|dans|pour|avec|mais|que|qui|nous|vous)(?:\s|$)/i;

const KEYBOX_CODE_RE = /code (?:de la|du) bo[iî]te?[ -]?(?:[àa]\s*)?cl[ée]s?\s*(?:est)?\s*:?\s*([0-9]{3,8}[A-Za-z]?)\b/i;
const GENERIC_CODE_RE = /\bcode\s*(?:est)?\s*:?\s*([0-9]{3,8})\b/i;
const GATE_CODE_RE = /code (?:du|de la|d')\s*(?:portail|portillon|barri[èe]re|grille|entr[ée]e|immeuble|r[ée]sidence|digicode)\s*(?:est)?\s*:?\s*([0-9]{3,8}[A-Za-z]?)\b/i;

// « le code a été remplacé par 5678 » : la NOUVELLE valeur est nommée
// explicitement. C'est le seul cas où une phrase porte deux valeurs, et la
// seule à retenir est celle qui suit le marqueur de remplacement — jamais
// l'ancienne, qui est justement celle qui ne vaut plus.
const REPLACED_BY_RE = /(?:remplac[ée]e?s?\s+par|est (?:d[ée]sormais|maintenant)|nouveau code(?:\s+est)?)\s*:?\s*([0-9]{3,8}[A-Za-z]?)\b/i;

const FLOOR_RE = /\b(\d{1,2})\s*(?:[èe]me|[èe]re|er|e)\s*[ée]tage\b/i;
const GROUND_FLOOR_RE = /\brez[- ]de[- ]chauss[ée]e\b/i;

// Le `\b` est PROSCRIT devant une préposition accentuée : en expression
// régulière JavaScript, « à » n'est pas un caractère de mot, donc la limite ne
// tombe jamais où on l'attend et « est située à côté de la porte » ne matchait
// pas. On exige une espace, ce qui est la vraie règle ici.
const KEY_LOCATION_RE = /(?:la\s*)?bo[iî]te?[ -]?(?:[àa]\s*)?cl[ée]s?\s+(?:est|se trouve|se situe)\s+(?:situ[ée]e?\s+)?((?:(?:à|a|au|aux|sur|sous|dans|derri[èe]re|devant|c[ôo]t[ée]|en|pr[èe]s|contre|le|la)\s.{3,140}))/i;

const PARKING_RE = /(stationn|parking|se garer|garer votre|places? de parking|emplacement num)/i;
const TRASH_RE = /(poubelle|conteneur|container|ordures m[ée]nag[èe]res|tri des d[ée]chets|bac (?:jaune|noir|vert))/i;
const ENTRY_RE = /(porte d'entr[ée]e|entr[ée]e (?:est|se (?:trouve|fait))|badge|interphone|sonnette|premi[èe]re porte|baie vitr[ée]e)/i;

const KEYBOX_MENTION_RE = /bo[iî]te?[ -]?(?:[àa]\s*)?cl[ée]/i;
const GATE_MENTION_RE = /portail|portillon|barri[èe]re|digicode|interphone/i;

const LOCKBOX_METHOD_RE = /(?:arriv[ée]e?\s+(?:se fait|est)\s+.{0,30}autonome|autonome\s+avec\s+une\s+bo[iî]te?\s*(?:[àa]\s*)?cl[ée]|bo[iî]te?[ -]?(?:[àa]\s*)?cl[ée]s?)/i;
const IN_PERSON_RE = /(?:je vous (?:accueille|attends|recevrai)|accueil en personne|remise des cl[ée]s en main propre)/i;

const PETS_YES_RE = /(?:les\s+)?(?:chiens|chats|animaux(?:\s+de\s+compagnie)?|nac)\s+(?:y\s+)?sont\s+(?:les\s+)?(?:accept[ée]s?|autoris[ée]s?|bienvenus?|admis)/i;
const PETS_NO_RE = /(?:les\s+)?(?:chiens|chats|animaux(?:\s+de\s+compagnie)?)\s+(?:ne\s+sont\s+pas|n'y\s+sont\s+pas|sont\s+interdits|ne\s+sont\s+jamais)\s*(?:accept[ée]s?|autoris[ée]s?|admis)?/i;

const ELEVATOR_YES_RE = /(?:il y a un ascenseur|ascenseur (?:est )?(?:disponible|dans l'immeuble|(?:à|a) (?:votre|disposition))|prene[zr] l'ascenseur|monter (?:par|avec) l'ascenseur|avec ascenseur)/i;
const ELEVATOR_NO_RE = /(?:pas d'ascenseur|sans ascenseur|aucun ascenseur)/i;

// Longueurs acceptables d'une valeur libre reprise mot pour mot. Trop courte,
// elle n'apprend rien ; trop longue, ce n'est plus une consigne mais un
// paragraphe entier qu'on recopierait dans la fiche.
const FREE_TEXT_MIN = 20;
const FREE_TEXT_MAX = 220;

// Étiquette d'introduction des messages type (« voici la procédure d'arrivée :
// La boîte à clé est … »). Elle annonce la consigne, elle n'en fait pas partie.
// La retirer ne reformule rien : le reste de la phrase est inchangé, mot pour
// mot.
const LEAD_LABEL_RE = /^(?:et\s+)?(?:voici|voil[àa])\b[^:]{0,60}:\s*/i;

/** Une phrase reprise telle quelle, si elle tient dans les bornes. */
function freeText(sentence) {
  const value = sentence.replace(LEAD_LABEL_RE, '').replace(/\s+/g, ' ').trim();
  if (value.length < FREE_TEXT_MIN || value.length > FREE_TEXT_MAX) return null;
  // Une phrase qui s'adresse nommément au voyageur n'est pas une consigne du
  // logement : « Bonjour Marie, ... ».
  if (/^(?:bonjour|bonsoir|salut|coucou|merci|re)\b/i.test(value)) return null;
  return value;
}

/**
 * Un identifiant de réseau ou un secret pollué par la ponctuation de la phrase.
 * On ne « répare » rien : on retire seulement ce qui ne peut pas en faire
 * partie (guillemets, point final), et on refuse le reste.
 */
function cleanToken(raw, { maxLength = 64 } = {}) {
  const value = String(raw === null || raw === undefined ? '' : raw)
    .replace(/^["'«»\s:]+/, '')
    .replace(/["'«».,;!\s]+$/, '')
    .trim();
  if (!value || value.length > maxLength) return null;
  // Un espace réservé Airbnb n'est pas une valeur (§11).
  if (/#\{[^}]*\}/.test(value)) return null;
  if (/^(?:[-–—]|n\/a|inconnu|aucun|est)$/i.test(value)) return null;
  return value;
}

/**
 * Tous les candidats d'UNE phrase.
 * @returns {Array<{key: string, value: string, kind: string}>}
 */
function extractFromSentence(sentence, kind) {
  const out = [];
  const push = (key, value) => {
    if (value === null || value === undefined || value === '') return;
    out.push({ key, value: String(value), kind });
  };

  let match;

  if ((match = CHECK_IN_RE.exec(sentence))) {
    push('check_in_time', normalizeTime(match.slice(1)));
  }
  if ((match = CHECK_OUT_RE.exec(sentence))) {
    push('check_out_time', normalizeTime(match.slice(1)));
  }

  if (/wi-?fi|r[ée]seau/i.test(sentence)) {
    if ((match = WIFI_PAIR_RE.exec(sentence))) {
      const ssid = cleanToken(match[1], { maxLength: 40 });
      // Deux garde-fous : le fragment ne doit pas être l'annonce du mot de
      // passe, et il ne doit pas ressembler à une phrase.
      if (ssid && !/mot de passe|password/i.test(ssid) && !PROSE_RE.test(ssid)) {
        push('wifi_name', ssid);
      }
    }
    if ((match = WIFI_PASSWORD_RE.exec(sentence))) {
      push('wifi_password', cleanToken(match[1], { maxLength: 48 }));
    }
  }

  const mentionsGate = GATE_MENTION_RE.test(sentence);
  const mentionsKeybox = KEYBOX_MENTION_RE.test(sentence);

  if (/\bcode\b/i.test(sentence) && (match = REPLACED_BY_RE.exec(sentence))) {
    push(mentionsGate && !mentionsKeybox ? 'gate_code' : 'access_code',
      cleanToken(match[1], { maxLength: 12 }));
  }

  if ((match = GATE_CODE_RE.exec(sentence))) {
    push('gate_code', cleanToken(match[1], { maxLength: 12 }));
  }
  if ((match = KEYBOX_CODE_RE.exec(sentence))) {
    push('access_code', cleanToken(match[1], { maxLength: 12 }));
  } else if (mentionsKeybox && !GATE_CODE_RE.test(sentence)
             && (match = GENERIC_CODE_RE.exec(sentence))) {
    // « Ouvrir la boîte à clé avec le code 0613 » : l'ancre est dans la phrase,
    // le mot « code » suit. Écarté si la phrase parle aussi du portail, pour ne
    // pas attribuer un code au mauvais verrou.
    push('access_code', cleanToken(match[1], { maxLength: 12 }));
  }

  if ((match = FLOOR_RE.exec(sentence))) {
    const floor = Number(match[1]);
    if (Number.isInteger(floor) && floor >= 0 && floor <= 60) push('floor_number', String(floor));
  } else if (GROUND_FLOOR_RE.test(sentence)) {
    push('floor_number', '0');
  }

  if (ELEVATOR_NO_RE.test(sentence)) push('has_elevator', 'false');
  else if (ELEVATOR_YES_RE.test(sentence)) push('has_elevator', 'true');

  if (PETS_NO_RE.test(sentence)) push('allows_pets', 'false');
  else if (PETS_YES_RE.test(sentence)) push('allows_pets', 'true');

  if ((match = KEY_LOCATION_RE.exec(sentence))) {
    const place = cleanToken(match[1], { maxLength: 160 });
    if (place && place.length >= 4) push('key_location', place);
  }

  if (IN_PERSON_RE.test(sentence)) push('checkin_method', 'in-person');
  else if (LOCKBOX_METHOD_RE.test(sentence)) push('checkin_method', 'lockbox');

  // Champs libres : la phrase entière est la valeur. Elle n'est retenue que si
  // elle est courte et si elle parle du sujet — c'est la formulation de l'hôte
  // qui est reprise, jamais une reformulation.
  if (PARKING_RE.test(sentence)) push('parking_info', freeText(sentence));
  if (TRASH_RE.test(sentence)) push('trash_instructions', freeText(sentence));
  if (ENTRY_RE.test(sentence)) push('building_entry', freeText(sentence));

  return out;
}

// ── Regroupement des formulations équivalentes ──────────────────────────────

const DIACRITICS = /[̀-ͯ]/g;

/**
 * Forme canonique servant à REGROUPER deux valeurs équivalentes (§6). La valeur
 * affichée reste la formulation d'origine la plus fréquente ; seule la clé de
 * regroupement est normalisée.
 *
 * La normalisation dépend du type, et c'est essentiel : un mot de passe ne peut
 * pas être comparé sans ses espaces (« AEaz kq9a » n'est pas « AEazkq9a »),
 * alors qu'un nom de réseau écrit « Riviere & Spa » puis « Riviere&Spa » est le
 * même réseau et ne doit pas passer pour une contradiction.
 */
function canonicalValue(key, value) {
  const raw = String(value === null || value === undefined ? '' : value).trim();
  switch (VALUE_TYPE[key]) {
    case 'time':
    case 'boolean':
    case 'enum':
      return raw.toLowerCase();
    case 'secret':
      // Sensible à la casse et aux espaces : un secret est une suite exacte.
      return raw;
    case 'text':
    default:
      return raw
        .toLowerCase()
        .normalize('NFD')
        .replace(DIACRITICS, '')
        .replace(/[^a-z0-9]+/g, '');
  }
}

/**
 * Tous les candidats d'un message.
 *
 * @param {string} text corps du message, écrit par l'HÔTE
 * @returns {Array<{key, value, kind, snippet}>}
 */
function extractCandidates(text) {
  const out = [];
  const seen = new Set();

  for (const sentence of sentences(text)) {
    const kind = classifySentence(sentence);
    // Une phrase AMBIGUË (question, incident, panne) ne produit RIEN. Ne pas
    // l'extraire du tout est plus sûr que l'extraire puis l'ignorer : il ne
    // reste aucun candidat douteux qu'un maillon suivant pourrait laisser
    // passer par erreur.
    if (kind === 'AMBIGUOUS') continue;

    for (const candidate of extractFromSentence(sentence, kind)) {
      // Un message qui répète trois fois la même valeur reste UNE preuve (§5) :
      // le dédoublonnage se fait ici, à la source.
      const seenKey = [candidate.key, candidate.kind, canonicalValue(candidate.key, candidate.value)].join(' ');
      if (seen.has(seenKey)) continue;
      seen.add(seenKey);
      out.push({ ...candidate, snippet: sentence.slice(0, 240) });
    }
  }

  return out;
}

module.exports = {
  extractCandidates,
  classifySentence,
  canonicalValue,
  isExclusive,
  STABILITY,
  VALUE_TYPE,
  FACT_LABELS,
  FACT_KEYS,
  EXCLUSIVE_KEYS,
  // Exposés pour les tests.
  __sentences: sentences,
  __extractFromSentence: extractFromSentence,
  __normalizeTime: normalizeTime,
  __freeText: freeText,
};

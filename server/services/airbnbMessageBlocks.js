/**
 * Découpage d'un e-mail de notification Airbnb en messages distincts.
 *
 * POURQUOI CE MODULE EXISTE
 * -------------------------
 * Un e-mail Airbnb ne contient pas toujours UN message. Le gabarit rend chaque
 * message sous la forme d'un bloc :
 *
 *     Pour votre protection et votre sécurité, communiquez toujours via Airbnb.
 *     FLORINE          <- nom de l'expéditeur
 *     Voyageur         <- rôle de l'expéditeur
 *     <texte>
 *     DELPHINE         <- bloc suivant : message précédent du fil
 *     Hôte
 *     <texte>
 *     Consulter la demande...
 *
 * extractAirbnbMessage() ne rendait que le PREMIER bloc trouvé, et sa liste
 * endPatterns s'arrêtait explicitement devant le bloc suivant. Un e-mail à
 * trois blocs produisait donc une seule ligne en base : c'est l'origine exacte
 * du « il me manque 2 ou 3 messages par conversation ». Le trou était invisible
 * parce que la comparaison d'audit se fait id Gmail <-> ligne, soit 1 pour 1.
 *
 * Pire, le bloc retenu n'était pas le premier en POSITION mais celui dont le
 * rôle apparaissait en premier dans la liste des motifs (Hôte avant Voyageur) :
 * sur un e-mail « Voyageur puis Hôte », le message du voyageur était jeté et le
 * rôle enregistré était faux.
 *
 * CE QUE REND CE MODULE
 * ---------------------
 * Tous les blocs, DANS L'ORDRE DU DOCUMENT, chacun avec son rôle lu sur sa
 * propre ligne de rôle — donc sans deviner un rôle unique pour tout l'e-mail.
 *
 * L'appelant (gmailSyncService) traite le bloc 0 comme le message que cet
 * e-mail annonce, et les suivants comme de l'HISTORIQUE CITÉ : ceux-là ne sont
 * réinsérés que s'ils sont absents de la conversation, ce qui couvre les deux
 * cas réels sans en casser un :
 *   - notification groupée (« vous avez 3 nouveaux messages ») : les blocs sont
 *     de vrais messages jamais reçus, ils sont insérés ;
 *   - rappel du fil sous un nouveau message : déjà en base, ignorés.
 *
 * Aucune I/O, aucune dépendance à la base : testable directement.
 */

// Les libellés de rôle que le gabarit Airbnb imprime sous le nom. Volontairement
// alignés sur guestNameExtractor.GUEST_ROLES / HOST_ROLES : ce sont les mêmes
// lignes du même gabarit, et les faire diverger ferait qu'un rôle reconnu pour
// nommer le voyageur ne le serait pas pour découper son message.
// Comparés après suppression des accents, d'où l'absence de variantes accentuées.
const GUEST_ROLES = ['voyageur', 'voyageuse', 'guest', 'traveler', 'traveller'];
const HOST_ROLES = [
  'hote', 'host', 'co-hote', 'cohote', 'co-host', 'cohost',
  'superhost', 'superhote', 'super-hote',
  'responsable de la reservation',
];

/**
 * Lignes qui marquent la fin de la zone « messages » et le début des boutons
 * d'action / du pied de page. Testées LIGNE PAR LIGNE (et non sur le corps
 * entier) : c'est ce qui permet de borner un bloc sans avaler le suivant.
 */
const END_LINE_PATTERNS = [
  /^Consulter\b/i,
  /^R[eé]pondre\b/i,
  /^R[eé]server\s+maintenant/i,
  /^Vous\s+pouvez\s+[eé]galement/i,
  /^Afficher\b/i,
  /^(?:View|Reply|Respond|See)\b/i,
  /^(?:Go to|Aller sur)\b/i,
  /^(?:Book now|Reserve now)/i,
  /^T[eé]l[eé]chargez\b/i,
  /^Download\b/i,
  /^Airbnb\s+Ireland/i,
  /^Airbnb,?\s+Inc/i,
  /^Modifiez\s+vos\s+pr[eé]f[eé]rences/i,
  /^Image\s+envoy[eé]e/i,
  /^Pour\s+votre\s+(?:protection|s[eé]curit[eé])/i,
  /^[-_=]{3,}$/,
];

const LETTERS = 'A-Za-zÀ-ÖØ-öø-ÿ';
// Une ligne de nom : que des lettres, espaces, tirets et apostrophes. Sert à
// distinguer « DELPHINE » (début du bloc suivant) d'une phrase du message.
const NAME_LINE_RE = new RegExp(`^[${LETTERS}][${LETTERS}'’\\-. ]{0,60}$`);

// Diacritiques combinants (U+0300..U+036F) laissés par la décomposition NFD.
const COMBINING_MARKS_RE = /[̀-ͯ]/g;

function stripAccents(value) {
  return String(value).normalize('NFD').replace(COMBINING_MARKS_RE, '');
}

function normalizeRoleLine(line) {
  return stripAccents(line).toLowerCase().replace(/[.,:;]+$/, '').trim();
}

function roleOfLine(line) {
  const value = normalizeRoleLine(line);
  if (!value) return null;
  if (GUEST_ROLES.includes(value)) return 'incoming';
  if (HOST_ROLES.includes(value)) return 'outgoing';
  return null;
}

function isEndLine(line) {
  return END_LINE_PATTERNS.some((re) => re.test(line));
}

/**
 * Nettoyage du texte d'un bloc — identique à celui qu'appliquait
 * extractAirbnbMessage(), pour que le contenu stocké ne change pas de forme
 * (ce qui casserait la comparaison avec les messages déjà en base).
 */
function cleanBlockText(text) {
  return text
    .replace(/%[a-z_]+%/gi, '')
    .replace(/https?:\/\/[^\s\])}>]+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Découpe le corps décodé d'un e-mail Airbnb en blocs de message.
 *
 * @param {string} body corps texte (après extractBody/stripHtml)
 * @returns {Array<{sender: string|null, role: 'incoming'|'outgoing', text: string, index: number}>}
 *          dans l'ordre du document. Tableau vide si aucun bloc identifiable —
 *          l'appelant retombe alors sur l'ancien extracteur.
 */
function extractAirbnbMessageBlocks(body) {
  if (!body || typeof body !== 'string') return [];

  const rawLines = body.split('\n');
  const lines = rawLines.map((l) => l.trim());

  // 1. Repérer chaque ligne de rôle et le nom qui la précède.
  const anchors = [];
  for (let i = 0; i < lines.length; i++) {
    const role = roleOfLine(lines[i]);
    if (!role) continue;

    // Remonter par-dessus les lignes vides jusqu'au nom.
    let nameIdx = i - 1;
    while (nameIdx >= 0 && lines[nameIdx] === '') nameIdx--;
    if (nameIdx < 0) continue;

    const nameLine = lines[nameIdx];
    // Une ligne de nom ne contient ni chiffre, ni URL, ni ponctuation de
    // phrase : sans ce garde-fou, la dernière phrase d'un message précédant le
    // mot « Voyageur » serait prise pour un nom et le bloc mal délimité.
    if (!NAME_LINE_RE.test(nameLine)) continue;
    if (isEndLine(nameLine)) continue;

    anchors.push({ roleIdx: i, nameIdx, role, sender: nameLine });
  }

  if (anchors.length === 0) return [];

  // 2. Borner chaque bloc.
  const blocks = [];
  for (let a = 0; a < anchors.length; a++) {
    const anchor = anchors[a];
    // Le bloc s'arrête juste avant la ligne de NOM du bloc suivant (pas avant
    // sa ligne de rôle : le nom lui appartient déjà).
    const hardStop = a + 1 < anchors.length ? anchors[a + 1].nameIdx : lines.length;

    let stop = hardStop;
    for (let i = anchor.roleIdx + 1; i < hardStop; i++) {
      if (lines[i] && isEndLine(lines[i])) { stop = i; break; }
    }

    const text = cleanBlockText(rawLines.slice(anchor.roleIdx + 1, stop).join('\n'));
    if (!text) continue;

    blocks.push({
      sender: anchor.sender || null,
      role: anchor.role,
      text,
      index: blocks.length,
    });
  }

  return blocks;
}

/**
 * Empreinte stable d'un message, utilisée pour reconnaître qu'un bloc cité
 * correspond à un message DÉJÀ stocké.
 *
 * Volontairement agressive (casse, accents, ponctuation, espaces) : l'ancien
 * extracteur tronquait les messages sur ses marqueurs de fin, donc la copie en
 * base est souvent un PRÉFIXE de la version citée. La comparaison par préfixe
 * côté appelant repose sur cette normalisation.
 *
 * Ce n'est PAS la clé de déduplication du sync — celle-là reste
 * (conversation_id, gmail_message_id), imposée par la base. Deux messages
 * identiques légitimes venant de deux e-mails DIFFÉRENTS gardent donc bien
 * deux lignes : seul un bloc CITÉ dans le même fil est comparé au contenu.
 */
function fingerprint(text) {
  return stripAccents(String(text || ''))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

module.exports = {
  extractAirbnbMessageBlocks,
  fingerprint,
  GUEST_ROLES,
  HOST_ROLES,
};

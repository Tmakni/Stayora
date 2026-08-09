/**
 * Migration 014 — Backfill des noms de voyageurs déjà enregistrés
 *
 * Avant cette mise à jour, gmailSyncService retombait sur le nom d'affichage de
 * l'en-tête From quand son extraction échouait. Or toutes les notifications
 * Airbnb arrivent de « Airbnb <express@airbnb.com> » : la quasi-totalité des
 * conversations existantes porte donc guest_name = "Airbnb" (223 sur 240 sur la
 * base de développement), plus quelques valeurs parasites produites par les
 * anciennes regex non validées ("dernière m", "lit p", "votre s", "to").
 *
 * Cette migration relit les messages DÉJÀ stockés de chaque conversation et
 * réapplique services/guestNameExtractor.js. Le contenu stocké a été nettoyé
 * par extractAirbnbMessage() (le bloc « Nom / Rôle » d'Airbnb n'y figure plus),
 * mais les sources suivantes y subsistent et suffisent dans la majorité des cas :
 *   — la formule d'appel de l'hôte dans un message sortant : « Bonjour Florine, »
 *   — la signature du voyageur en fin de message entrant : « Merci, \n Florine »
 *   — les notifications système : « à l'attention du voyageur (Skogran) »
 *
 * Garanties :
 *   — chaque conversation n'est calculée QU'À PARTIR DE SES PROPRES messages,
 *     jamais de ceux d'un autre thread ni d'un autre utilisateur ;
 *   — le nom de l'hôte (bloc « Hôte » / « Co-hôte ») est exclu explicitement ;
 *   — une conversation dont le nom est déjà fiable n'est pas touchée ;
 *   — faute de nom fiable, on écrit "Voyageur" et jamais "Airbnb" ;
 *   — traitement par lots, sans jamais charger toute la table en mémoire.
 */

const {
  FALLBACK_GUEST_NAME,
  extractGuestNameFromThread,
  extractRoleBlocks,
  normalizeName,
  nameKey,
} = require('../../server/services/guestNameExtractor');

const CONVERSATION_BATCH = 200;
const MESSAGES_PER_CONVERSATION = 40;
const MESSAGE_SCAN_BATCH = 500;

/**
 * Relève les noms marqués « Hôte » / « Co-hôte » par Airbnb dans TOUS les
 * messages d'un utilisateur, pour les exclure ensuite de chaque conversation.
 *
 * Indispensable : un voyageur écrit couramment « Bonjour Delphine, » à son hôte,
 * et le rôle du message n'est pas toujours correctement détecté à la
 * synchronisation. Sans cette liste, le nom de l'HÔTE finit affiché comme celui
 * du voyageur (constaté sur 3 conversations de la base de développement).
 */
async function collectHostNamesByUser(knex) {
  const hostNamesByUser = new Map();
  let lastId = 0;

  for (;;) {
    const rows = await knex('messages as m')
      .join('conversations as c', 'c.id', 'm.conversation_id')
      .select('m.id as id', 'm.content as content', 'c.user_id as user_id')
      .where('m.id', '>', lastId)
      .orderBy('m.id', 'asc')
      .limit(MESSAGE_SCAN_BATCH);

    if (rows.length === 0) break;

    for (const row of rows) {
      lastId = row.id;
      const { hostNames } = extractRoleBlocks(row.content || '');
      if (hostNames.length === 0) continue;
      if (!hostNamesByUser.has(row.user_id)) hostNamesByUser.set(row.user_id, new Set());
      const set = hostNamesByUser.get(row.user_id);
      for (const name of hostNames) set.add(name);
    }
  }

  return hostNamesByUser;
}

exports.up = async function (knex) {
  const hasConfidence = await knex.schema.hasColumn('conversations', 'guest_name_confidence');
  if (!hasConfidence) {
    // 013 n'a pas tourné (base partielle) — rien à backfiller de façon fiable.
    return;
  }

  const hostNamesByUser = await collectHostNamesByUser(knex);
  if (hostNamesByUser.size > 0) {
    // eslint-disable-next-line no-console
    console.log(
      '[014] Noms d\'hôte détectés (exclus des voyageurs) : ' +
      [...hostNamesByUser.entries()]
        .map(([userId, names]) => `user ${userId} → ${[...names].join(', ')}`)
        .join(' | ')
    );
  }

  let lastId = 0;
  let scanned = 0;
  let renamed = 0;
  let placeholders = 0;

  for (;;) {
    const conversations = await knex('conversations')
      .select('id', 'user_id', 'title', 'guest_name', 'guest_name_confidence')
      .where('id', '>', lastId)
      .orderBy('id', 'asc')
      .limit(CONVERSATION_BATCH);

    if (conversations.length === 0) break;

    for (const conversation of conversations) {
      lastId = conversation.id;
      scanned++;

      if (!needsBackfill(conversation)) continue;

      // Uniquement les messages DE CETTE conversation.
      const messages = await knex('messages')
        .select('role', 'content')
        .where({ conversation_id: conversation.id })
        .orderBy('created_at', 'asc')
        .limit(MESSAGES_PER_CONVERSATION);

      if (messages.length === 0) {
        if (isAirbnbPlaceholder(conversation.guest_name)) {
          await applyName(knex, conversation, {
            name: FALLBACK_GUEST_NAME,
            source: 'fallback',
            confidence: 0,
          });
          placeholders++;
        }
        continue;
      }

      const result = extractGuestNameFromThread(
        messages.map((m) => ({
          body: m.content || '',
          role: m.role === 'outgoing' ? 'outgoing' : 'incoming',
        })),
        { knownHostNames: [...(hostNamesByUser.get(conversation.user_id) || [])] }
      );

      await applyName(knex, conversation, result);
      if (result.confidence > 0) renamed++;
      else placeholders++;
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[014] Backfill noms voyageurs : ${scanned} conversations examinées, ` +
    `${renamed} nommées depuis le contenu, ${placeholders} basculées sur "${FALLBACK_GUEST_NAME}".`
  );
};

exports.down = async function () {
  // Backfill de données : pas de retour arrière (les anciennes valeurs étaient
  // "Airbnb" ou des fragments erronés, rien qui vaille d'être restauré).
};

/** "Airbnb" et les fragments produits par les anciennes regex sont à remplacer. */
function isAirbnbPlaceholder(guestName) {
  const key = nameKey(guestName);
  return key === '' || key === 'airbnb';
}

function needsBackfill(conversation) {
  // Un nom déjà attribué par une source scorée est considéré comme fiable.
  if (conversation.guest_name_confidence > 0) return false;
  if (isAirbnbPlaceholder(conversation.guest_name)) return true;
  // Reste les valeurs héritées : à remplacer si elles ne ressemblent pas à un nom.
  return normalizeName(conversation.guest_name) === null;
}

/**
 * Écrit le nom et réaligne le titre.
 * Les titres valent « Airbnb – La Villa Cosy » : on remplace le segment de nom
 * en tête tout en conservant le nom du logement.
 */
async function applyName(knex, conversation, result) {
  const previous = conversation.guest_name;
  let title = conversation.title;

  if (title && previous && title.startsWith(previous)) {
    title = result.name + title.slice(previous.length);
  } else if (title && nameKey(title) === 'airbnb') {
    title = result.name;
  }

  await knex('conversations')
    .where({ id: conversation.id })
    .update({
      guest_name: result.name,
      guest_name_source: result.source,
      guest_name_confidence: result.confidence,
      title,
    });
}

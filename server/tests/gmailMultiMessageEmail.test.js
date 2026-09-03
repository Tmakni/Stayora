/**
 * UN e-mail Airbnb peut porter PLUSIEURS messages — et aucun ne doit se perdre.
 *
 * C'est la cause confirmée du « il me manque 2 ou 3 messages par conversation ».
 * Le gabarit Airbnb rend chaque message comme un bloc « nom / rôle / texte », et
 * une notification en porte régulièrement deux ou trois : celui qu'elle annonce,
 * puis le rappel de ceux qui précèdent. L'ancien extractAirbnbMessage() n'en
 * rendait qu'un, et son jeu de marqueurs de fin s'arrêtait EXPLICITEMENT devant
 * le bloc suivant. Deux messages sur trois disparaissaient donc en silence, et
 * l'audit ne pouvait pas le voir : il comparait 1 identifiant Gmail à 1 ligne.
 *
 * Second défaut couvert ici : le bloc retenu n'était pas le premier en POSITION
 * mais celui dont le rôle apparaissait en premier dans la liste des motifs
 * (« Hôte » avant « Voyageur »). Sur un e-mail « Voyageur puis Hôte », le
 * message du voyageur était jeté ET le rôle enregistré était celui de l'hôte.
 *
 * Tourne sur l'environnement "test" du knexfile : SQLite en mémoire.
 */

jest.mock('../services/propertyQAService', () => ({ extractConversationQA: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/autoReplyService', () => ({ scheduleForConversation: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/statusDetector', () => ({ autoUpdateStatus: jest.fn().mockResolvedValue(null) }));

const { initDatabase, getDatabase } = require('../config/db');
const database = require('../db/database');
const gmailSync = require('../services/gmailSyncService');
const { extractAirbnbMessageBlocks } = require('../services/airbnbMessageBlocks');

const { __syncGmailThread: syncGmailThread } = gmailSync;

let db;
const TAG = `multi-${process.pid}-${Date.now()}`;
const HOST_EMAIL = `host-${TAG}@example.test`;

const b64url = (text) => Buffer.from(text, 'utf8').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_');

/**
 * Corps d'un e-mail Airbnb portant N blocs, dans l'ordre du gabarit réel :
 * le message annoncé en premier, l'historique rappelé en dessous.
 */
function airbnbMultiBody({ subject, blocks, airbnbThreadId }) {
  const lines = [
    subject, '',
    'Pour votre protection et votre sécurité, communiquez toujours via Airbnb.', '',
  ];
  for (const b of blocks) {
    lines.push(b.sender, '', b.role, '', b.text, '');
  }
  lines.push(
    'Répondre',
    `https://www.airbnb.fr/hosting/thread/${airbnbThreadId}?euid=cf60135e`,
    '',
    'Airbnb Ireland UC, 8 Hanover Quay, Dublin 2, Ireland',
  );
  return lines.join('\n');
}

function gmailMessage({ id, subject, body, date }) {
  return {
    id,
    internalDate: String(new Date(date).getTime()),
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: 'Airbnb <express@airbnb.com>' },
        { name: 'Subject', value: subject },
        { name: 'Date', value: new Date(date).toUTCString() },
        { name: 'Reply-To', value: `reply+${id}@reply.airbnb.com` },
        { name: 'Message-ID', value: `<${id}@geopod-ismtpd-30>` },
      ],
      parts: [{ mimeType: 'text/plain', body: { data: b64url(body) } }],
    },
  };
}

async function createUser(email) {
  const res = await db.query('INSERT INTO users (email, password_hash) VALUES (?, ?)', [email, 'x'.repeat(20)]);
  return res.insertId;
}

async function createGmailAccount(userId, email) {
  const res = await db.query(
    'INSERT INTO gmail_accounts (user_id, email, is_active) VALUES (?, ?, TRUE)',
    [userId, email]
  );
  return res.insertId;
}

const accountFor = (email) => ({ id: 1, email, display_name: null, host_names_json: null });

async function messagesOf(conversationId) {
  return db.query(
    `SELECT role, content, gmail_message_id, created_at, metadata_json
       FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC`,
    [conversationId]
  );
}

const flushImmediates = () => new Promise((resolve) => setImmediate(resolve));

async function onlyConversation(userId) {
  const rows = await db.query('SELECT id FROM conversations WHERE user_id = ? ORDER BY id ASC', [userId]);
  expect(rows).toHaveLength(1);
  return rows[0].id;
}

beforeAll(async () => {
  await initDatabase();
  db = getDatabase();
});

afterEach(async () => { await flushImmediates(); });

afterAll(async () => {
  await flushImmediates();
  await database.close();
});

// ────────────────────────────────────────────────────────────────────────────
describe('découpage d\'un e-mail en blocs (pur, sans base)', () => {
  it('rend TOUS les blocs, dans l\'ordre du document, avec leur propre rôle', () => {
    const body = airbnbMultiBody({
      subject: 'Demande de réservation',
      airbnbThreadId: '999',
      blocks: [
        { sender: 'FLORINE', role: 'Voyageur', text: 'Bonjour, le parking est-il inclus ?' },
        { sender: 'DELPHINE', role: 'Hôte', text: 'Bonjour Florine, oui il est inclus.' },
        { sender: 'FLORINE', role: 'Voyageur', text: 'Parfait, je réserve.' },
      ],
    });

    const blocks = extractAirbnbMessageBlocks(body);

    expect(blocks.map((b) => b.text)).toEqual([
      'Bonjour, le parking est-il inclus ?',
      'Bonjour Florine, oui il est inclus.',
      'Parfait, je réserve.',
    ]);
    // Le rôle vient de la ligne de rôle du bloc, pas d'une devinette sur l'e-mail.
    expect(blocks.map((b) => b.role)).toEqual(['incoming', 'outgoing', 'incoming']);
  });

  it('prend le premier bloc EN POSITION, pas le premier rôle de la liste', () => {
    // Défaut historique : rolePatterns testait « Hôte » avant « Voyageur », donc
    // sur cet e-mail le message du voyageur était jeté et le rôle stocké faux.
    const body = airbnbMultiBody({
      subject: 'Nouveau message',
      airbnbThreadId: '888',
      blocks: [
        { sender: 'MARIE', role: 'Voyageur', text: 'Est-ce que je peux arriver plus tôt ?' },
        { sender: 'DELPHINE', role: 'Hôte', text: 'Je vous confirme demain.' },
      ],
    });

    const blocks = extractAirbnbMessageBlocks(body);
    expect(blocks[0].role).toBe('incoming');
    expect(blocks[0].text).toBe('Est-ce que je peux arriver plus tôt ?');
  });

  it('ne rend aucun bloc sur un corps sans ligne de rôle (repli sur l\'ancien chemin)', () => {
    expect(extractAirbnbMessageBlocks('Bonjour,\n\nMerci pour tout.\n')).toEqual([]);
    expect(extractAirbnbMessageBlocks('')).toEqual([]);
    expect(extractAirbnbMessageBlocks(null)).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('un e-mail portant plusieurs messages en enregistre plusieurs', () => {
  const SUBJECT = `Demande d'information pour Villa ${TAG}`;
  const THREAD = '5544332211';

  it('enregistre les 3 messages d\'un seul e-mail, avec le bon rôle et le bon ordre', async () => {
    const userId = await createUser(`three-${TAG}@example.test`);
    const accountId = await createGmailAccount(userId, HOST_EMAIL);

    const msg = gmailMessage({
      id: `mail-3-${TAG}`,
      subject: SUBJECT,
      date: '2026-05-10T10:00:00Z',
      body: airbnbMultiBody({
        subject: SUBJECT,
        airbnbThreadId: THREAD,
        blocks: [
          { sender: 'FLORINE', role: 'Voyageur', text: 'Bonjour, le parking est-il inclus ?' },
          { sender: 'DELPHINE', role: 'Hôte', text: 'Bonjour Florine, oui il est inclus.' },
          { sender: 'FLORINE', role: 'Voyageur', text: 'Super, merci pour la précision.' },
        ],
      }),
    });

    const saved = await syncGmailThread(
      userId, accountId, accountFor(HOST_EMAIL), null, `t-3-${TAG}`, [msg], [], new Set()
    );

    expect(saved).toBe(3);

    const stored = await messagesOf(await onlyConversation(userId));
    expect(stored).toHaveLength(3);

    // Clés déterministes : l'identifiant nu pour le message annoncé, puis #n.
    expect(stored.map((m) => m.gmail_message_id).sort()).toEqual(
      [`mail-3-${TAG}`, `mail-3-${TAG}#1`, `mail-3-${TAG}#2`].sort()
    );

    const byKey = Object.fromEntries(stored.map((m) => [m.gmail_message_id, m]));
    expect(byKey[`mail-3-${TAG}`].role).toBe('incoming');
    expect(byKey[`mail-3-${TAG}#1`].role).toBe('outgoing');
    expect(byKey[`mail-3-${TAG}#2`].role).toBe('incoming');

    // Les blocs rappelés sont datés AVANT le message annoncé, jamais après.
    expect(byKey[`mail-3-${TAG}#1`].created_at < byKey[`mail-3-${TAG}`].created_at).toBe(true);
    expect(JSON.parse(byKey[`mail-3-${TAG}#1`].metadata_json).recovered_from_quote).toBe(true);
    // Le message annoncé, lui, n'est pas marqué comme rappelé.
    expect(JSON.parse(byKey[`mail-3-${TAG}`].metadata_json).recovered_from_quote).toBeUndefined();
  });

  it('resynchroniser le même e-mail n\'ajoute aucun doublon', async () => {
    const userId = await createUser(`idem3-${TAG}@example.test`);
    const accountId = await createGmailAccount(userId, HOST_EMAIL);

    const msg = gmailMessage({
      id: `mail-idem-${TAG}`,
      subject: SUBJECT,
      date: '2026-05-11T10:00:00Z',
      body: airbnbMultiBody({
        subject: SUBJECT,
        airbnbThreadId: THREAD,
        blocks: [
          { sender: 'MARIE', role: 'Voyageur', text: 'Bonjour, avez-vous un lit bébé ?' },
          { sender: 'DELPHINE', role: 'Hôte', text: 'Oui, un lit parapluie est disponible.' },
        ],
      }),
    });

    const first = await syncGmailThread(userId, accountId, accountFor(HOST_EMAIL), null, `t-idem3-${TAG}`, [msg], [], new Set());
    const second = await syncGmailThread(userId, accountId, accountFor(HOST_EMAIL), null, `t-idem3-${TAG}`, [msg], [], new Set());
    const third = await syncGmailThread(userId, accountId, accountFor(HOST_EMAIL), null, `t-idem3-${TAG}`, [msg], [], new Set());

    expect(first).toBe(2);
    expect(second).toBe(0);
    expect(third).toBe(0);
    expect(await messagesOf(await onlyConversation(userId))).toHaveLength(2);
  });

  it('un bloc déjà livré par son propre e-mail n\'est pas réinséré quand un e-mail plus récent le rappelle', async () => {
    const userId = await createUser(`quote-${TAG}@example.test`);
    const accountId = await createGmailAccount(userId, HOST_EMAIL);

    const question = 'Bonjour, est-ce que la piscine est chauffée toute l\'année ?';
    const answer = 'Oui, elle est chauffée de mars à octobre.';

    // 1er e-mail : la question seule.
    const mail1 = gmailMessage({
      id: `q-${TAG}`,
      subject: SUBJECT,
      date: '2026-05-12T09:00:00Z',
      body: airbnbMultiBody({
        subject: SUBJECT, airbnbThreadId: THREAD,
        blocks: [{ sender: 'PAUL', role: 'Voyageur', text: question }],
      }),
    });

    // 2e e-mail : la réponse de l'hôte, avec la question RAPPELÉE en dessous.
    const mail2 = gmailMessage({
      id: `a-${TAG}`,
      subject: SUBJECT,
      date: '2026-05-12T10:00:00Z',
      body: airbnbMultiBody({
        subject: SUBJECT, airbnbThreadId: THREAD,
        blocks: [
          { sender: 'DELPHINE', role: 'Hôte', text: answer },
          { sender: 'PAUL', role: 'Voyageur', text: question },
        ],
      }),
    });

    await syncGmailThread(userId, accountId, accountFor(HOST_EMAIL), null, `t-quote-${TAG}`, [mail1, mail2], [], new Set());

    const stored = await messagesOf(await onlyConversation(userId));
    // 2 messages, pas 3 : la question n'est comptée qu'une fois.
    expect(stored).toHaveLength(2);
    expect(stored.map((m) => m.content)).toEqual([question, answer]);
  });

  it('récupère un message JAMAIS reçu isolément, présent seulement dans un rappel', async () => {
    // Cas réel : la notification du 1er message n'est jamais arrivée (spam
    // purgé, panne, fenêtre incrémentale sautée). Le message n'existe que dans
    // l'historique cité de la notification suivante — et doit être récupéré.
    const userId = await createUser(`recover-${TAG}@example.test`);
    const accountId = await createGmailAccount(userId, HOST_EMAIL);

    const lost = 'Bonjour, je cherche un logement pour 4 personnes en août.';

    const mail = gmailMessage({
      id: `rec-${TAG}`,
      subject: SUBJECT,
      date: '2026-05-13T10:00:00Z',
      body: airbnbMultiBody({
        subject: SUBJECT, airbnbThreadId: THREAD,
        blocks: [
          { sender: 'DELPHINE', role: 'Hôte', text: 'Bonjour, oui le logement accueille 4 personnes.' },
          { sender: 'LEA', role: 'Voyageur', text: lost },
        ],
      }),
    });

    await syncGmailThread(userId, accountId, accountFor(HOST_EMAIL), null, `t-rec-${TAG}`, [mail], [], new Set());

    const stored = await messagesOf(await onlyConversation(userId));
    expect(stored).toHaveLength(2);
    expect(stored.some((m) => m.content === lost && m.role === 'incoming')).toBe(true);
  });

  it('un message rappelé ne déclenche jamais de réponse automatique', async () => {
    const autoReply = require('../services/autoReplyService');
    await flushImmediates();
    autoReply.scheduleForConversation.mockClear();

    const userId = await createUser(`noreply-${TAG}@example.test`);
    const accountId = await createGmailAccount(userId, HOST_EMAIL);

    // Le message annoncé est celui de l'HÔTE ; seul un message rappelé du
    // voyageur suit. Rien ne doit être programmé : le voyageur n'a rien envoyé
    // de nouveau, et l'hôte a déjà répondu.
    const mail = gmailMessage({
      id: `nr-${TAG}`,
      subject: SUBJECT,
      date: '2026-05-14T10:00:00Z',
      body: airbnbMultiBody({
        subject: SUBJECT, airbnbThreadId: THREAD,
        blocks: [
          { sender: 'DELPHINE', role: 'Hôte', text: 'Je vous confirme la disponibilité.' },
          { sender: 'HUGO', role: 'Voyageur', text: 'Le logement est-il libre du 3 au 9 ?' },
        ],
      }),
    });

    await syncGmailThread(userId, accountId, accountFor(HOST_EMAIL), null, `t-nr-${TAG}`, [mail], [], new Set());
    await flushImmediates();

    expect(autoReply.scheduleForConversation).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
describe('isolation entre utilisateurs', () => {
  it('deux hôtes recevant le même e-mail gardent des messages séparés', async () => {
    const userA = await createUser(`iso-a-${TAG}@example.test`);
    const userB = await createUser(`iso-b-${TAG}@example.test`);
    const accountA = await createGmailAccount(userA, `a-${TAG}@example.test`);
    const accountB = await createGmailAccount(userB, `b-${TAG}@example.test`);

    const body = airbnbMultiBody({
      subject: 'Message partagé',
      airbnbThreadId: '4242',
      blocks: [
        { sender: 'CAMILLE', role: 'Voyageur', text: 'Bonjour, quelles sont les heures d\'arrivée ?' },
        { sender: 'DELPHINE', role: 'Hôte', text: 'À partir de 16 h.' },
      ],
    });
    const mail = gmailMessage({ id: `shared-${TAG}`, subject: 'Message partagé', date: '2026-05-15T10:00:00Z', body });

    await syncGmailThread(userA, accountA, accountFor(`a-${TAG}@example.test`), null, `t-iso-a-${TAG}`, [mail], [], new Set());
    await syncGmailThread(userB, accountB, accountFor(`b-${TAG}@example.test`), null, `t-iso-b-${TAG}`, [mail], [], new Set());

    const convA = await onlyConversation(userA);
    const convB = await onlyConversation(userB);
    expect(convA).not.toBe(convB);
    expect(await messagesOf(convA)).toHaveLength(2);
    expect(await messagesOf(convB)).toHaveLength(2);

    // Aucun message de A n'est rattaché à une conversation de B.
    const crossed = await db.query(
      `SELECT COUNT(*) AS n FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.user_id = ? AND m.conversation_id = ?`,
      [userA, convB]
    );
    expect(Number(crossed[0].n)).toBe(0);
  });
});

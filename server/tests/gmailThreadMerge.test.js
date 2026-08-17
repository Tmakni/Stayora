/**
 * Messages manquants dans les conversations Gmail → Airbnb
 *
 * Ce que ces tests verrouillent, mesuré sur une vraie boîte hôte (547
 * conversations / 3476 messages) :
 *
 *  1. Un fil Gmail qui contient N messages Airbnb doit produire N messages en
 *     base, chacun avec SON gmail_message_id et son rôle. C'est le cas nominal
 *     — s'il casse, chaque conversation perd des messages silencieusement.
 *
 *  2. Les mails de notification Airbnb ne portent AUCUN en-tête References /
 *     In-Reply-To (2 sur 3290 dans la boîte auditée). Gmail ne peut donc les
 *     regrouper que par SUJET, et Airbnb réécrit le sujet au fil de la
 *     réservation ("Demande d'information pour X" → "Préapprobation pour X" →
 *     "Réservation pour X"). Chaque réécriture ouvre un NOUVEAU fil Gmail pour
 *     la MÊME conversation Airbnb. L'airbnb_thread_id est la seule clé qui les
 *     réunit, et il n'était consulté qu'au moment d'ENREGISTRER un fil : une
 *     conversation déjà coupée en deux le restait pour toujours. Mesuré : les
 *     conversations sans airbnb_thread_id ont 2,48 messages en moyenne contre
 *     10,13 pour celles qui en ont un — d'où "Airbnb affiche 2 à 3 fois plus de
 *     messages".
 *
 *  3. Une fusion déplace des messages d'une conversation vers une autre : c'est
 *     précisément l'opération qui ne doit JAMAIS franchir une frontière de
 *     compte.
 *
 *  4. L'extraction de l'identifiant de fil doit reconnaître le format que
 *     Airbnb envoie réellement (/hosting/thread/<id>) et ne pas confondre un
 *     identifiant d'annonce avec un identifiant de conversation.
 *
 * Tourne sur l'environnement "test" du knexfile : SQLite en mémoire.
 */

// Enrichissement Q&A et réponse automatique sont déclenchés en setImmediate par
// le sync ; ils ne font pas partie de ce qui est testé ici et parleraient à la
// base après la fin du test.
jest.mock('../services/propertyQAService', () => ({ extractConversationQA: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/autoReplyService', () => ({ scheduleForConversation: jest.fn().mockResolvedValue(null) }));

const { initDatabase, getDatabase } = require('../config/db');
const database = require('../db/database');
const gmailSync = require('../services/gmailSyncService');

const {
  __syncGmailThread: syncGmailThread,
  __mergeConversationInto: mergeConversationInto,
  __extractAirbnbThreadIdFromMessage: extractThreadId,
} = gmailSync;

let db;
const TAG = `gmail-merge-${process.pid}-${Date.now()}`;
const HOST_EMAIL = `host-${TAG}@example.test`;

// ── Fabrication de messages Gmail réalistes ────────────────────────────────

const b64url = (text) => Buffer.from(text, 'utf8').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_');

/**
 * Corps d'une notification Airbnb tel que stripHtml() le produit : titre, avis
 * de sécurité, nom de l'expéditeur, son rôle, le message, puis les boutons.
 * Le lien de fil est au format réellement envoyé aujourd'hui.
 */
function airbnbBody({ sender, role, text, airbnbThreadId, subject }) {
  return [
    subject,
    '',
    'Pour votre protection et votre sécurité, communiquez toujours via Airbnb.',
    '',
    sender,
    '',
    role,
    '',
    text,
    '',
    'Répondre',
    `https://www.airbnb.fr/hosting/thread/${airbnbThreadId}?open_scheduled_messages=true&euid=cf60135e-fffc`,
    '',
    'Airbnb Ireland UC, 8 Hanover Quay, Dublin 2, Ireland',
  ].join('\n');
}

function gmailMessage({ id, subject, body, date, from = 'Airbnb <express@airbnb.com>' }) {
  return {
    id,
    internalDate: String(new Date(date).getTime()),
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: subject },
        { name: 'Date', value: new Date(date).toUTCString() },
        { name: 'Reply-To', value: `reply+${id}@reply.airbnb.com` },
        { name: 'Message-ID', value: `<${id}@geopod-ismtpd-30>` },
      ],
      parts: [{ mimeType: 'text/plain', body: { data: b64url(body) } }],
    },
  };
}

/** Un message de voyageur (incoming) dans le fil Airbnb donné. */
function guestMessage({ id, text, airbnbThreadId, subject, date, sender = 'Florine' }) {
  return gmailMessage({
    id, subject, date,
    body: airbnbBody({ sender, role: 'Voyageur', text, airbnbThreadId, subject }),
  });
}

/**
 * Message de voyageur dont le nom n'est PAS récupérable — le cas majoritaire
 * en production (312 des 547 conversations auditées portent le nom générique
 * "Voyageur"). Le rapprochement par nom est alors désactivé par conception, et
 * seul l'airbnb_thread_id peut réunir les fils : c'est exactement ce que les
 * tests de fusion doivent éprouver, sans filet.
 */
function anonymousGuestMessage(args) {
  return guestMessage({ ...args, sender: 'Airbnb' });
}

/** Une notification de la réponse de l'hôte (outgoing). */
function hostMessage({ id, text, airbnbThreadId, subject, date, sender = 'Delphine' }) {
  return gmailMessage({
    id, subject, date,
    body: airbnbBody({ sender, role: 'Hôte', text, airbnbThreadId, subject }),
  });
}

// ── Fixtures ───────────────────────────────────────────────────────────────

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

/** L'objet compte tel que fetchMessages le passe à syncGmailThread. */
const accountFor = (email) => ({ id: 1, email, display_name: null, host_names_json: null });

async function messagesOf(conversationId) {
  return db.query(
    'SELECT role, content, gmail_message_id FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC',
    [conversationId]
  );
}

beforeAll(async () => {
  await initDatabase();
  db = getDatabase();
}, 60000);

afterAll(async () => {
  try {
    const users = await db.query('SELECT id FROM users WHERE email LIKE ?', [`%${TAG}%`]);
    const ids = users.map((u) => u.id);
    if (ids.length > 0) {
      const ph = ids.map(() => '?').join(',');
      const convs = await db.query(`SELECT id FROM conversations WHERE user_id IN (${ph})`, ids);
      const convIds = convs.map((c) => c.id);
      if (convIds.length > 0) {
        const cph = convIds.map(() => '?').join(',');
        await db.query(`DELETE FROM messages WHERE conversation_id IN (${cph})`, convIds);
      }
      await db.query(`DELETE FROM gmail_threads WHERE user_id IN (${ph})`, ids);
      await db.query(`DELETE FROM conversations WHERE user_id IN (${ph})`, ids);
      await db.query(`DELETE FROM gmail_accounts WHERE user_id IN (${ph})`, ids);
      await db.query(`DELETE FROM users WHERE id IN (${ph})`, ids);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('cleanup failed:', err.message);
  }
  await database.close();
}, 30000);

// ───────────────────────────────────────────────────────────────────────────
describe('un fil Gmail contenant plusieurs messages', () => {
  it('enregistre CHAQUE message du fil, avec son gmailMessageId et son rôle', async () => {
    const userId = await createUser(`multi-${TAG}@example.test`);
    const accountId = await createGmailAccount(userId, HOST_EMAIL);
    const subject = "Objet : Demande d'information pour La Villa Cosy, 24–28 août";
    const AIRBNB_THREAD = '2482565367';

    // Le cas qui compte : quatre allers-retours dans UN SEUL fil Gmail.
    const msgs = [
      guestMessage({ id: 'g1', text: 'Bonjour, le logement est-il disponible ?', airbnbThreadId: AIRBNB_THREAD, subject, date: '2026-04-01T09:00:00Z' }),
      hostMessage({ id: 'h1', text: 'Bonjour Florine, oui il est libre.', airbnbThreadId: AIRBNB_THREAD, subject, date: '2026-04-01T10:00:00Z' }),
      guestMessage({ id: 'g2', text: 'Parfait, y a-t-il un parking ?', airbnbThreadId: AIRBNB_THREAD, subject, date: '2026-04-01T11:00:00Z' }),
      hostMessage({ id: 'h2', text: 'Oui, une place privée devant la maison.', airbnbThreadId: AIRBNB_THREAD, subject, date: '2026-04-01T12:00:00Z' }),
    ];

    const saved = await syncGmailThread(
      userId, accountId, accountFor(HOST_EMAIL), null, 'gmail-thread-A', msgs, [], new Set()
    );
    expect(saved).toBe(4);

    const convs = await db.query('SELECT id FROM conversations WHERE user_id = ?', [userId]);
    expect(convs).toHaveLength(1);

    const stored = await messagesOf(convs[0].id);
    // Aucun message ne doit disparaître, et aucun ne doit être écrasé par un autre.
    expect(stored).toHaveLength(4);
    expect(stored.map((m) => m.gmail_message_id)).toEqual(['g1', 'h1', 'g2', 'h2']);
    expect(stored.map((m) => m.role)).toEqual(['incoming', 'outgoing', 'incoming', 'outgoing']);
    expect(stored[0].content).toContain('le logement est-il disponible');
    expect(stored[2].content).toContain('parking');
  });

  it('est idempotent : re-synchroniser le même fil ne duplique ni ne perd rien', async () => {
    const userId = await createUser(`idem-${TAG}@example.test`);
    const accountId = await createGmailAccount(userId, HOST_EMAIL);
    const subject = 'Objet : Réservation pour La Planquette, 7–9 avr.';
    const msgs = [
      guestMessage({ id: 'i1', text: 'Nous arrivons vers 18h.', airbnbThreadId: '2483910270', subject, date: '2026-04-02T09:00:00Z' }),
      hostMessage({ id: 'i2', text: 'Très bien, à tout à l\'heure.', airbnbThreadId: '2483910270', subject, date: '2026-04-02T09:30:00Z' }),
    ];

    await syncGmailThread(userId, accountId, accountFor(HOST_EMAIL), null, 'gmail-thread-B', msgs, [], new Set());
    const secondPass = await syncGmailThread(userId, accountId, accountFor(HOST_EMAIL), null, 'gmail-thread-B', msgs, [], new Set());

    expect(secondPass).toBe(0);
    const convs = await db.query('SELECT id FROM conversations WHERE user_id = ?', [userId]);
    expect(convs).toHaveLength(1);
    expect(await messagesOf(convs[0].id)).toHaveLength(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('conversation Airbnb éclatée sur plusieurs fils Gmail', () => {
  it('réunit les fils qui partagent un airbnb_thread_id, sans perdre de message', async () => {
    const userId = await createUser(`split-${TAG}@example.test`);
    const accountId = await createGmailAccount(userId, HOST_EMAIL);
    const AIRBNB_THREAD = '2584178274';

    // Airbnb change le sujet quand la réservation progresse → Gmail ouvre un
    // second fil pour la même conversation.
    const inquiry = "Objet : Demande d'information pour Le Cocon Terracotta, 1–6 avr.";
    const booking = 'Objet : Réservation pour Le Cocon Terracotta, 1–6 avr.';

    // Voyageur anonyme : aucun rapprochement par nom possible, seul
    // l'airbnb_thread_id peut recoller les deux fils.
    await syncGmailThread(userId, accountId, accountFor(HOST_EMAIL), null, 'gmail-thread-C1', [
      anonymousGuestMessage({ id: 's1', text: 'Bonjour, est-ce disponible début avril ?', airbnbThreadId: AIRBNB_THREAD, subject: inquiry, date: '2026-03-01T09:00:00Z' }),
      anonymousGuestMessage({ id: 's2', text: 'Nous serions quatre personnes.', airbnbThreadId: AIRBNB_THREAD, subject: inquiry, date: '2026-03-01T10:00:00Z' }),
    ], [], new Set());

    await syncGmailThread(userId, accountId, accountFor(HOST_EMAIL), null, 'gmail-thread-C2', [
      anonymousGuestMessage({ id: 's3', text: 'Réservation faite, merci !', airbnbThreadId: AIRBNB_THREAD, subject: booking, date: '2026-03-02T09:00:00Z' }),
      anonymousGuestMessage({ id: 's4', text: 'Une question sur les clés.', airbnbThreadId: AIRBNB_THREAD, subject: booking, date: '2026-03-02T11:00:00Z' }),
    ], [], new Set());

    const convs = await db.query('SELECT id FROM conversations WHERE user_id = ?', [userId]);
    expect(convs).toHaveLength(1);
    const stored = await messagesOf(convs[0].id);
    expect(stored).toHaveLength(4);
    expect(stored.map((m) => m.gmail_message_id).sort()).toEqual(['s1', 's2', 's3', 's4']);
  });

  it('recolle une conversation déjà coupée en deux lors d\'une synchronisation ultérieure', async () => {
    const userId = await createUser(`late-${TAG}@example.test`);
    const accountId = await createGmailAccount(userId, HOST_EMAIL);
    const AIRBNB_THREAD = '2589108352';
    const subject = 'Objet : Réservation pour La Villa Rivière, 27–31 mars';

    // Premier fil : le mail ne contient aucun lien de conversation, donc la
    // conversation naît SANS clé de regroupement — l'état dans lequel se
    // trouvent 49 % des conversations de la boîte auditée.
    const noLinkBody = [
      subject, '', 'Pour votre protection et votre sécurité, communiquez toujours via Airbnb.',
      '', 'Airbnb', '', 'Voyageur', '', 'Bonjour, une question avant de réserver.', '', 'Répondre',
    ].join('\n');
    await syncGmailThread(userId, accountId, accountFor(HOST_EMAIL), null, 'gmail-thread-D1', [
      gmailMessage({ id: 'l1', subject, body: noLinkBody, date: '2026-03-05T09:00:00Z' }),
    ], [], new Set());

    const first = await db.query('SELECT id, airbnb_thread_id FROM conversations WHERE user_id = ?', [userId]);
    expect(first).toHaveLength(1);
    expect(first[0].airbnb_thread_id).toBeFalsy();

    // Second fil : Airbnb a réécrit le sujet, Gmail ouvre un nouveau fil. Le
    // lien est présent cette fois, mais rien ne le relie encore au premier fil.
    await syncGmailThread(userId, accountId, accountFor(HOST_EMAIL), null, 'gmail-thread-D2', [
      anonymousGuestMessage({ id: 'l2', text: 'Merci pour votre réponse.', airbnbThreadId: AIRBNB_THREAD, subject, date: '2026-03-06T09:00:00Z' }),
    ], [], new Set());

    // C'est bien le bug d'origine : la conversation est coupée en deux.
    const split = await db.query('SELECT id FROM conversations WHERE user_id = ? ORDER BY id', [userId]);
    expect(split).toHaveLength(2);

    // Le premier fil resynchronise et porte maintenant le même identifiant
    // Airbnb : les deux moitiés doivent se recoller.
    await syncGmailThread(userId, accountId, accountFor(HOST_EMAIL), null, 'gmail-thread-D1', [
      gmailMessage({ id: 'l1', subject, body: noLinkBody, date: '2026-03-05T09:00:00Z' }),
      anonymousGuestMessage({ id: 'l3', text: 'Et une dernière chose.', airbnbThreadId: AIRBNB_THREAD, subject, date: '2026-03-07T09:00:00Z' }),
    ], [], new Set());

    const after = await db.query('SELECT id FROM conversations WHERE user_id = ?', [userId]);
    expect(after).toHaveLength(1);
    const stored = await messagesOf(after[0].id);
    expect(stored.map((m) => m.gmail_message_id).sort()).toEqual(['l1', 'l2', 'l3']);

    // Les deux fils Gmail pointent désormais sur la conversation survivante.
    const threads = await db.query('SELECT conversation_id FROM gmail_threads WHERE user_id = ?', [userId]);
    expect(threads).toHaveLength(2);
    expect(threads.every((t) => t.conversation_id === after[0].id)).toBe(true);
  });

  it('retrouve la conversation du voyageur même sur un compte très chargé', async () => {
    const userId = await createUser(`busy-${TAG}@example.test`);
    const accountId = await createGmailAccount(userId, HOST_EMAIL);
    const subject = 'Objet : Réservation pour Bordeaux Easy Stay, 12–15 juin';

    // Premier fil de "Gaelle", sans lien de conversation : le rapprochement ne
    // pourra se faire que par le nom.
    const namedNoLink = (text) => [
      subject, '', 'Pour votre protection et votre sécurité, communiquez toujours via Airbnb.',
      '', 'Gaelle', '', 'Voyageur', '', text, '', 'Répondre',
    ].join('\n');

    await syncGmailThread(userId, accountId, accountFor(HOST_EMAIL), null, 'busy-first', [
      gmailMessage({ id: 'b1', subject, body: namedNoLink('Bonjour, à quelle heure peut-on arriver ?'), date: '2026-06-01T09:00:00Z' }),
    ], [], new Set());

    // 60 autres conversations arrivent ensuite et deviennent les plus récentes.
    // L'ancienne implémentation ne regardait que les 20 (ou 40) dernières
    // conversations mises à jour AVANT de comparer les noms : celle de Gaelle
    // était sortie de la fenêtre, donc invisible.
    for (let i = 0; i < 60; i++) {
      await db.query(
        `INSERT INTO conversations (user_id, title, booking_status, external_provider, guest_name, guest_name_confidence)
         VALUES (?, ?, 'inquiry', 'gmail', ?, 100)`,
        [userId, `bruit-${i}`, `Bruit${i}`]
      );
    }

    // Second fil du même voyageur : il doit rejoindre la conversation existante.
    await syncGmailThread(userId, accountId, accountFor(HOST_EMAIL), null, 'busy-second', [
      gmailMessage({ id: 'b2', subject, body: namedNoLink('Finalement nous arriverons vers 20h.'), date: '2026-06-02T09:00:00Z' }),
    ], [], new Set());

    const gaelle = await db.query(
      'SELECT id FROM conversations WHERE user_id = ? AND guest_name = ?',
      [userId, 'Gaelle']
    );
    expect(gaelle).toHaveLength(1);
    expect((await messagesOf(gaelle[0].id)).map((m) => m.gmail_message_id)).toEqual(['b1', 'b2']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('isolation par utilisateur', () => {
  it('refuse de fusionner deux conversations appartenant à des comptes différents', async () => {
    const userA = await createUser(`iso-a-${TAG}@example.test`);
    const userB = await createUser(`iso-b-${TAG}@example.test`);
    const accA = await createGmailAccount(userA, `a-${TAG}@example.test`);
    const accB = await createGmailAccount(userB, `b-${TAG}@example.test`);
    const subject = 'Objet : Réservation pour Green Lodge, 2–4 mai';

    // Les deux comptes voient le MÊME identifiant de fil Airbnb — un co-hôte
    // peut recevoir les notifications de la même conversation.
    const SHARED = '2628162797';
    await syncGmailThread(userA, accA, accountFor(`a-${TAG}@example.test`), null, 'gmail-thread-E', [
      guestMessage({ id: 'x1', text: 'Message chez A.', airbnbThreadId: SHARED, subject, date: '2026-05-01T09:00:00Z' }),
    ], [], new Set());
    await syncGmailThread(userB, accB, accountFor(`b-${TAG}@example.test`), null, 'gmail-thread-F', [
      guestMessage({ id: 'x2', text: 'Message chez B.', airbnbThreadId: SHARED, subject, date: '2026-05-01T10:00:00Z' }),
    ], [], new Set());

    const convA = await db.query('SELECT id FROM conversations WHERE user_id = ?', [userA]);
    const convB = await db.query('SELECT id FROM conversations WHERE user_id = ?', [userB]);
    expect(convA).toHaveLength(1);
    expect(convB).toHaveLength(1);

    // Chacun garde son propre message : aucune fusion inter-comptes.
    expect((await messagesOf(convA[0].id)).map((m) => m.gmail_message_id)).toEqual(['x1']);
    expect((await messagesOf(convB[0].id)).map((m) => m.gmail_message_id)).toEqual(['x2']);

    // Et une fusion explicitement demandée à travers la frontière est refusée.
    const moved = await mergeConversationInto(db, userA, convB[0].id, convA[0].id);
    expect(moved).toBe(0);
    expect(await messagesOf(convB[0].id)).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('extraction de l\'identifiant de fil Airbnb', () => {
  const withBody = (text) => gmailMessage({ id: 'z', subject: 'Objet : test', body: text, date: '2026-04-01T09:00:00Z' });

  it('reconnaît le format réellement envoyé par Airbnb (/hosting/thread/<id>)', () => {
    const msg = withBody('Examiner le message\nhttps://www.airbnb.fr/hosting/thread/2482565367?open_scheduled_messages=true&euid=cf60');
    expect(extractThreadId(msg).threadId).toBe('2482565367');
  });

  it('décode un lien enveloppé par le suivi SendGrid (upn=)', () => {
    // SendGrid encode la destination avec "-" au lieu de "%".
    const wrapped = 'https://email.airbnb.com/ls/click?upn=https-3A-2F-2Fwww.airbnb.fr-2Fhosting-2Fthread-2F2628278815-3Fs-3D1';
    expect(extractThreadId(withBody(wrapped)).threadId).toBe('2628278815');
  });

  it('ne prend pas un identifiant d\'annonce pour un identifiant de conversation', () => {
    // Le lien vers l'annonce arrive AVANT celui du fil dans le corps du mail :
    // l'ancien filet de sécurité renvoyait 12345678 et faisait fusionner toutes
    // les conversations d'un même logement.
    const msg = withBody([
      'Votre annonce https://www.airbnb.fr/rooms/12345678',
      'Répondre https://www.airbnb.fr/hosting/thread/2628278815?s=1',
    ].join('\n'));
    expect(extractThreadId(msg).threadId).toBe('2628278815');
  });

  it('ne renvoie rien plutôt qu\'un identifiant douteux quand il n\'y a aucun lien de fil', () => {
    const msg = withBody('Un nouvel appareil a accédé à votre compte.\nhttps://www.airbnb.fr/account-settings/notifications/98765432');
    expect(extractThreadId(msg).threadId).toBeNull();
  });
});

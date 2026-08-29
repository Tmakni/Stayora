/**
 * Aucun message ne doit disparaître entre Gmail et la conversation affichée.
 *
 * L'hôte constatait « je n'arrive jamais à avoir tous les messages ». L'API
 * renvoie pourtant l'intégralité d'une conversation (aucun LIMIT) et le client
 * n'en tronque aucun : les pertes sont toutes à l'INGESTION. Trois mécanismes
 * distincts, verrouillés ici :
 *
 *  1. SILENCE. Un message dont le corps MIME est vide, ou que le parser Airbnb
 *     n'arrive pas à découper, était purement et simplement `continue`-é. Rien
 *     n'était écrit, donc rien ne gardait trace de son existence : le fil
 *     paraissait complet, les trous étaient invisibles. C'est ce que
 *     scripts/audit-missing-messages.js compte en `corps-vide` / `parser-vide`.
 *
 *  2. REPÈRE. `last_sync_at` est le bord gauche de la prochaine fenêtre
 *     `after:`. L'écrire vaut promesse que tout ce qui précède est importé. Il
 *     était posé à NOW() APRÈS la boucle, et même quand des fils avaient
 *     échoué — la fenêtre suivante enjambait donc ce qui venait d'être manqué,
 *     définitivement, puisque plus rien ne reliste ce fil.
 *
 *  3. RATTRAPAGE. La réconciliation relit les fils déjà connus hors de toute
 *     fenêtre : un trou creusé par n'importe quelle cause finit comblé.
 *
 * Tourne sur l'environnement "test" du knexfile : SQLite en mémoire.
 */

jest.mock('../services/propertyQAService', () => ({ extractConversationQA: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/autoReplyService', () => ({ scheduleForConversation: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/statusDetector', () => ({ autoUpdateStatus: jest.fn().mockResolvedValue(null) }));

const { initDatabase, getDatabase } = require('../config/db');
const database = require('../db/database');
const gmailSync = require('../services/gmailSyncService');

const { __syncGmailThread: syncGmailThread } = gmailSync;

let db;
const TAG = `gmail-complete-${process.pid}-${Date.now()}`;
const HOST_EMAIL = `host-${TAG}@example.test`;

const b64url = (text) => Buffer.from(text, 'utf8').toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_');

function airbnbBody({ sender, role, text, airbnbThreadId, subject }) {
  return [
    subject, '',
    'Pour votre protection et votre sécurité, communiquez toujours via Airbnb.', '',
    sender, '', role, '', text, '',
    'Répondre',
    `https://www.airbnb.fr/hosting/thread/${airbnbThreadId}?euid=cf60135e`,
    '', 'Airbnb Ireland UC, 8 Hanover Quay, Dublin 2, Ireland',
  ].join('\n');
}

function gmailMessage({ id, subject, body, date, parts = null }) {
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
      parts: parts !== null ? parts : [{ mimeType: 'text/plain', body: { data: b64url(body) } }],
    },
  };
}

function guestMessage({ id, text, airbnbThreadId, subject, date, sender = 'Florine' }) {
  return gmailMessage({
    id, subject, date,
    body: airbnbBody({ sender, role: 'Voyageur', text, airbnbThreadId, subject }),
  });
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
    `SELECT role, content, gmail_message_id, metadata_json
       FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC`,
    [conversationId]
  );
}

/**
 * Vide la file des setImmediate en attente.
 *
 * Indispensable ici : better-sqlite3 est SYNCHRONE, donc chaque `await
 * db.query(...)` se résout en microtâche et ne rend jamais la main à la file
 * des immediates. Les enrichissements que le sync programme en setImmediate
 * (Q&A, statut, réponse automatique) restent donc en attente jusqu'au premier
 * vrai point de cède — c'est-à-dire, sans ce vidage, au milieu du test SUIVANT,
 * où ils se font compter comme des appels de celui-ci.
 */
const flushImmediates = () => new Promise((resolve) => setImmediate(resolve));

beforeAll(async () => {
  await initDatabase();
  db = getDatabase();
});

afterEach(async () => {
  await flushImmediates();
});

afterAll(async () => {
  await flushImmediates();
  await database.close();
});

describe('un message illisible est conservé, jamais perdu', () => {
  const SUBJECT = `Réservation pour Villa ${TAG}`;
  const THREAD = '1122334455';

  it('enregistre un message dont le corps MIME est vide', async () => {
    const userId = await createUser(`empty-${TAG}@example.test`);
    const accountId = await createGmailAccount(userId, HOST_EMAIL);

    const msgs = [
      guestMessage({ id: `m1-${TAG}`, text: 'Bonjour, à quelle heure le check-in ?', airbnbThreadId: THREAD, subject: SUBJECT, date: '2026-05-01T10:00:00Z' }),
      // Corps absent : aucune part exploitable. Auparavant → `continue` muet.
      gmailMessage({ id: `m2-${TAG}`, subject: SUBJECT, body: '', date: '2026-05-01T11:00:00Z', parts: [] }),
      guestMessage({ id: `m3-${TAG}`, text: 'Et le parking est inclus ?', airbnbThreadId: THREAD, subject: SUBJECT, date: '2026-05-01T12:00:00Z' }),
    ];

    await syncGmailThread(userId, accountId, accountFor(HOST_EMAIL), null, `t-empty-${TAG}`, msgs, [], new Set());

    const convs = await db.query('SELECT id FROM conversations WHERE user_id = ?', [userId]);
    const stored = await messagesOf(convs[0].id);

    // Les TROIS messages Gmail sont en base, chacun avec son identifiant.
    expect(stored).toHaveLength(3);
    expect(stored.map((m) => m.gmail_message_id)).toEqual([`m1-${TAG}`, `m2-${TAG}`, `m3-${TAG}`]);

    const placeholder = stored.find((m) => m.gmail_message_id === `m2-${TAG}`);
    expect(placeholder.content).toMatch(/non lisible/i);
    expect(JSON.parse(placeholder.metadata_json).unreadable).toBe('empty_body');
  });

  it("ne recrée pas le substitut à chaque synchronisation", async () => {
    const userId = await createUser(`idem-${TAG}@example.test`);
    const accountId = await createGmailAccount(userId, HOST_EMAIL);

    const msgs = [
      gmailMessage({ id: `dup-${TAG}`, subject: SUBJECT, body: '', date: '2026-05-02T10:00:00Z', parts: [] }),
    ];

    const first = await syncGmailThread(userId, accountId, accountFor(HOST_EMAIL), null, `t-idem-${TAG}`, msgs, [], new Set());
    const second = await syncGmailThread(userId, accountId, accountFor(HOST_EMAIL), null, `t-idem-${TAG}`, msgs, [], new Set());

    expect(first).toBe(1);
    expect(second).toBe(0);

    const convs = await db.query('SELECT id FROM conversations WHERE user_id = ?', [userId]);
    expect(await messagesOf(convs[0].id)).toHaveLength(1);
  });

  it("un message illisible ne déclenche pas de réponse automatique", async () => {
    // Michel ne doit pas répondre à un corps qu'il n'a pas su lire.
    const autoReply = require('../services/autoReplyService');
    await flushImmediates();
    autoReply.scheduleForConversation.mockClear();

    const userId = await createUser(`noauto-${TAG}@example.test`);
    const accountId = await createGmailAccount(userId, HOST_EMAIL);

    await syncGmailThread(
      userId, accountId, accountFor(HOST_EMAIL), null, `t-noauto-${TAG}`,
      [gmailMessage({ id: `na-${TAG}`, subject: SUBJECT, body: '', date: '2026-05-03T10:00:00Z', parts: [] })],
      [], new Set()
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(autoReply.scheduleForConversation).not.toHaveBeenCalled();
  });

  it('un vrai message déclenche bien la réponse automatique', async () => {
    // Contre-épreuve : le test précédent doit prouver un filtre, pas une panne.
    const autoReply = require('../services/autoReplyService');
    await flushImmediates();
    autoReply.scheduleForConversation.mockClear();

    const userId = await createUser(`auto-${TAG}@example.test`);
    const accountId = await createGmailAccount(userId, HOST_EMAIL);

    await syncGmailThread(
      userId, accountId, accountFor(HOST_EMAIL), null, `t-auto-${TAG}`,
      [guestMessage({ id: `ok-${TAG}`, text: 'Le wifi fonctionne comment ?', airbnbThreadId: THREAD, subject: SUBJECT, date: '2026-05-04T10:00:00Z' })],
      [], new Set()
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(autoReply.scheduleForConversation).toHaveBeenCalled();
  });
});

describe('le repère de synchronisation ne dépasse jamais ce qui a été lu', () => {
  const { __finishSyncLog: finishSyncLog } = gmailSync;

  async function newAccount() {
    const userId = await createUser(`wm-${TAG}-${Math.random().toString(36).slice(2, 8)}@example.test`);
    const accountId = await createGmailAccount(userId, HOST_EMAIL);
    const res = await db.query(
      'INSERT INTO sync_logs (user_id, sync_type, status) VALUES (?, ?, ?)',
      [userId, 'messages', 'started']
    );
    return { userId, accountId, syncLogId: res.insertId };
  }

  it("pose le repère au DÉBUT du passage, pas à la fin", async () => {
    const { accountId, syncLogId } = await newAccount();

    // Un passage qui a commencé il y a 10 minutes et se termine maintenant.
    const startedAt = new Date(Date.now() - 10 * 60 * 1000);
    await finishSyncLog(db, syncLogId, 3, accountId, { watermark: startedAt, complete: true });

    const [row] = await db.query('SELECT last_sync_at FROM gmail_accounts WHERE id = ?', [accountId]);
    const stored = new Date(`${String(row.last_sync_at).replace(' ', 'T')}Z`).getTime();

    // Le repère vaut l'heure de DÉBUT (à la seconde près), et non NOW() :
    // sinon les 10 minutes de travail tombent hors des deux fenêtres.
    expect(Math.abs(stored - startedAt.getTime())).toBeLessThan(2000);
    expect(Date.now() - stored).toBeGreaterThan(9 * 60 * 1000);
  });

  it("n'avance PAS le repère quand un fil n'a pas pu être lu", async () => {
    const { accountId, syncLogId } = await newAccount();

    const before = new Date(Date.now() - 60 * 60 * 1000);
    await db.query('UPDATE gmail_accounts SET last_sync_at = ? WHERE id = ?',
      [before.toISOString().slice(0, 19).replace('T', ' '), accountId]);

    await finishSyncLog(db, syncLogId, 1, accountId, {
      watermark: new Date(), complete: false, incompleteThreads: 2,
    });

    const [row] = await db.query('SELECT last_sync_at, sync_status FROM gmail_accounts WHERE id = ?', [accountId]);
    const stored = new Date(`${String(row.last_sync_at).replace(' ', 'T')}Z`).getTime();

    // Inchangé : la prochaine fenêtre reprend AVANT les fils manqués.
    expect(Math.abs(stored - before.getTime())).toBeLessThan(2000);
    // Le compte reste utilisable — ce n'est pas une erreur, juste un retard.
    expect(row.sync_status).toBe('idle');
  });

  it("finit par avancer si des fils restent illisibles trop longtemps", async () => {
    // Un fil sur lequel Gmail échoue systématiquement ne doit pas figer la
    // fenêtre pour toujours : sinon chaque cycle de 60 s relit toute la boîte.
    // Passé le délai, la réconciliation prend le relais sur ces fils.
    const { accountId, syncLogId } = await newAccount();

    const veryOld = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await db.query('UPDATE gmail_accounts SET last_sync_at = ? WHERE id = ?',
      [veryOld.toISOString().slice(0, 19).replace('T', ' '), accountId]);

    const watermark = new Date(Date.now() - 60 * 1000);
    await finishSyncLog(db, syncLogId, 0, accountId, {
      watermark, complete: false, incompleteThreads: 1,
    });

    const [row] = await db.query('SELECT last_sync_at FROM gmail_accounts WHERE id = ?', [accountId]);
    const stored = new Date(`${String(row.last_sync_at).replace(' ', 'T')}Z`).getTime();
    expect(Math.abs(stored - watermark.getTime())).toBeLessThan(2000);
  });

  it('avance le repère quand tout a été lu', async () => {
    const { accountId, syncLogId } = await newAccount();
    const watermark = new Date(Date.now() - 5 * 60 * 1000);

    await finishSyncLog(db, syncLogId, 0, accountId, { watermark, complete: true });

    const [row] = await db.query('SELECT last_sync_at FROM gmail_accounts WHERE id = ?', [accountId]);
    const stored = new Date(`${String(row.last_sync_at).replace(' ', 'T')}Z`).getTime();
    expect(Math.abs(stored - watermark.getTime())).toBeLessThan(2000);
  });
});

describe('réconciliation — rattrapage hors fenêtre', () => {
  const SUBJECT = `Réservation pour Chalet ${TAG}`;
  const THREAD = '9988776655';

  it('récupère un message qu\'aucune fenêtre incrémentale ne rattraperait', async () => {
    const userId = await createUser(`recon-${TAG}@example.test`);
    const accountId = await createGmailAccount(userId, HOST_EMAIL);
    const gmailThreadId = `t-recon-${TAG}`;

    const first = guestMessage({ id: `r1-${TAG}`, text: 'Bonjour, le logement est-il calme ?', airbnbThreadId: THREAD, subject: SUBJECT, date: '2026-04-01T10:00:00Z' });

    // Premier passage : un seul message importé.
    await syncGmailThread(userId, accountId, accountFor(HOST_EMAIL), null, gmailThreadId, [first], [], new Set());

    const convs = await db.query('SELECT id FROM conversations WHERE user_id = ?', [userId]);
    const conversationId = convs[0].id;
    expect(await messagesOf(conversationId)).toHaveLength(1);

    // Un second message est arrivé mais a été manqué (échec Gmail, redémarrage,
    // horloge...). Il est ANCIEN : la fenêtre `after:` ne le relistera jamais.
    const missed = guestMessage({ id: `r2-${TAG}`, text: 'Et y a-t-il un ascenseur ?', airbnbThreadId: THREAD, subject: SUBJECT, date: '2026-04-01T11:00:00Z' });

    // La réconciliation relit le fil complet, tel que threads.get le renvoie.
    const recovered = await syncGmailThread(
      userId, accountId, accountFor(HOST_EMAIL), null, gmailThreadId, [first, missed], [], new Set()
    );

    expect(recovered).toBe(1);
    const stored = await messagesOf(conversationId);
    expect(stored).toHaveLength(2);
    expect(stored.map((m) => m.gmail_message_id).sort()).toEqual([`r1-${TAG}`, `r2-${TAG}`].sort());
  });

  it('la colonne reconciled_at existe et ordonne la file de rattrapage', async () => {
    const userId = await createUser(`recol-${TAG}@example.test`);
    const accountId = await createGmailAccount(userId, HOST_EMAIL);

    await syncGmailThread(
      userId, accountId, accountFor(HOST_EMAIL), null, `t-col-${TAG}`,
      [guestMessage({ id: `c1-${TAG}`, text: 'Une question simple sur le séjour.', airbnbThreadId: THREAD, subject: SUBJECT, date: '2026-04-02T10:00:00Z' })],
      [], new Set()
    );

    // NULL = jamais réconcilié → passe en tête, donc le passif est traité
    // dès la première passe après la migration.
    const rows = await db.query(
      `SELECT gmail_thread_id, reconciled_at FROM gmail_threads
        WHERE gmail_account_id = ? ORDER BY COALESCE(reconciled_at, '1970-01-01') ASC`,
      [accountId]
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].reconciled_at).toBeFalsy();
  });
});

/**
 * Tests d'intégration sur un VRAI MySQL.
 *
 * Pourquoi ils existent alors que toute la suite tourne déjà sur SQLite : les
 * deux moteurs sont d'accord sur les requêtes de cette application, mais pas
 * sur ce qui est vérifié ici.
 *
 *   - SQLite est faiblement typé : il stocke « pas-une-date » dans une colonne
 *     DATE sans broncher. MySQL refuse.
 *   - SQLite tronque ou accepte selon la configuration ; MySQL applique les
 *     longueurs déclarées.
 *   - Les index UNIQUE et la sémantique des NULL dans un index unique ont la
 *     même intention dans les deux moteurs, mais rien ne le PROUVE tant que la
 *     migration n'a pas été jouée sur MySQL.
 *
 * Autrement dit : une contrainte vérifiée seulement sur SQLite n'est pas une
 * contrainte vérifiée. Ces tests jouent les migrations réelles sur MySQL et
 * éprouvent les garanties que la base est censée offrir.
 *
 * ATTENTION à ce que ces tests ne prétendent PAS : la production tourne
 * actuellement sur SQLite (render.yaml, USE_MEMORY_DB=true). Le chemin MySQL
 * existe dans le knexfile mais n'est pas déployé. Ces tests couvrent donc un
 * environnement POSSIBLE, pas l'environnement courant.
 *
 * Sans TEST_MYSQL_HOST, la suite entière est ignorée explicitement : un test
 * vert sur un moteur absent serait pire que pas de test.
 */

const MYSQL_AVAILABLE = !!process.env.TEST_MYSQL_HOST;
const describeMysql = MYSQL_AVAILABLE ? describe : describe.skip;

if (!MYSQL_AVAILABLE) {
  // Visible dans la sortie de jest : personne ne doit croire que c'est passé.
  console.warn(
    '\n[mysqlSchema] IGNORÉ — TEST_MYSQL_HOST non défini, aucun serveur MySQL.\n' +
    '  Pour l\'exécuter :\n' +
    '    docker run --rm -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=michel_test -p 3307:3306 mysql:8\n' +
    '    TEST_MYSQL_HOST=127.0.0.1 TEST_MYSQL_PORT=3307 TEST_MYSQL_PASSWORD=root npx jest mysqlSchema\n'
  );
}

describeMysql('schéma sur MySQL réel', () => {
  let knex;
  const TAG = `mysql-${process.pid}-${Date.now()}`;

  beforeAll(async () => {
    knex = require('knex')(require('../../knexfile').mysqlTest);
    // Table rase : les migrations doivent pouvoir construire le schéma entier
    // depuis rien, ce qui est aussi ce que fait un premier déploiement.
    await knex.migrate.rollback(undefined, true).catch(() => {});
    await knex.migrate.latest();
  }, 120_000);

  afterAll(async () => {
    if (knex) await knex.destroy();
  });

  async function makeUser(suffix = '') {
    const [id] = await knex('users').insert({
      email: `u-${TAG}${suffix}@example.test`,
      password_hash: 'x'.repeat(20),
    });
    return id;
  }

  async function makeConversation(userId, title = 'conv') {
    const [id] = await knex('conversations').insert({ user_id: userId, title });
    return id;
  }

  // ── Migrations ──────────────────────────────────────────────────────────

  it('joue toutes les migrations sur MySQL sans erreur', async () => {
    const [, completed] = await knex.migrate.list();
    expect(completed.length).toBe(0); // plus rien en attente
  });

  it('crée bien toutes les tables attendues', async () => {
    const rows = await knex.raw('SHOW TABLES');
    const names = rows[0].map((r) => Object.values(r)[0]);
    for (const t of ['users', 'conversations', 'messages', 'gmail_accounts', 'gmail_threads', 'outbound_replies', 'reservations']) {
      expect(names).toContain(t);
    }
  });

  // ── Migration 020 : un message Gmail = une ligne ────────────────────────

  describe('unicité des messages Gmail (migration 020)', () => {
    it('refuse deux fois le même gmail_message_id dans une conversation', async () => {
      const userId = await makeUser('-dup');
      const convId = await makeConversation(userId);

      await knex('messages').insert({
        conversation_id: convId, role: 'incoming', content: 'premier', gmail_message_id: 'gm-1',
      });

      // C'est la course prouvée sur SQLite : deux importateurs, un seul message.
      // MySQL doit la refuser aussi.
      await expect(
        knex('messages').insert({
          conversation_id: convId, role: 'incoming', content: 'doublon', gmail_message_id: 'gm-1',
        })
      ).rejects.toThrow(/Duplicate entry/i);

      const rows = await knex('messages').where({ conversation_id: convId, gmail_message_id: 'gm-1' });
      expect(rows).toHaveLength(1);
    });

    it('autorise le MÊME identifiant Gmail dans deux conversations distinctes', async () => {
      // La portée est volontairement la conversation, pas la base : une fusion
      // repointe des messages, et un identifiant Gmail n'est unique que dans UNE
      // boîte. Un UNIQUE global casserait ces deux cas.
      const userId = await makeUser('-scope');
      const a = await makeConversation(userId, 'A');
      const b = await makeConversation(userId, 'B');

      await knex('messages').insert({ conversation_id: a, role: 'incoming', content: 'x', gmail_message_id: 'gm-shared' });
      await expect(
        knex('messages').insert({ conversation_id: b, role: 'incoming', content: 'x', gmail_message_id: 'gm-shared' })
      ).resolves.toBeDefined();
    });

    it('laisse passer plusieurs NULL (messages saisis à la main)', async () => {
      // Les NULL sont distincts dans un index unique — sur MySQL comme sur
      // SQLite. Si ce n'était pas le cas, l'hôte ne pourrait écrire qu'un seul
      // message manuel par conversation.
      const userId = await makeUser('-null');
      const convId = await makeConversation(userId);
      for (let i = 0; i < 3; i++) {
        await knex('messages').insert({ conversation_id: convId, role: 'outgoing', content: `manuel ${i}` });
      }
      const rows = await knex('messages').where({ conversation_id: convId }).whereNull('gmail_message_id');
      expect(rows).toHaveLength(3);
    });
  });

  // ── Migration 021 : unicité des réservations par hôte ───────────────────

  describe('unicité des réservations par hôte (migration 021)', () => {
    it('laisse deux hôtes enregistrer la même réservation Airbnb (co-hébergement)', async () => {
      const hostA = await makeUser('-resA');
      const hostB = await makeUser('-resB');
      const resaId = `RESA-${TAG}`;

      const row = (userId) => ({
        user_id: userId, airbnb_reservation_id: resaId,
        check_in_date: '2026-07-01', check_out_date: '2026-07-08',
      });

      await expect(knex('reservations').insert(row(hostA))).resolves.toBeDefined();
      // Bloqué par l'ancien UNIQUE global — c'est la régression que 021 corrige.
      await expect(knex('reservations').insert(row(hostB))).resolves.toBeDefined();
    });

    it('refuse toujours le doublon CHEZ LE MÊME hôte', async () => {
      const userId = await makeUser('-resDup');
      const resaId = `RESA-DUP-${TAG}`;
      const row = { user_id: userId, airbnb_reservation_id: resaId, check_in_date: '2026-08-01', check_out_date: '2026-08-05' };

      await knex('reservations').insert(row);
      await expect(knex('reservations').insert(row)).rejects.toThrow(/Duplicate entry/i);
    });
  });

  // ── Typage réel : ce que SQLite ne peut pas prouver ─────────────────────

  describe('typage strict des colonnes', () => {
    it('refuse une date malformée dans une colonne DATE', async () => {
      // SQLite stocke « pas-une-date » sans broncher, ce qui rendait le trou de
      // validation de addCalendarBlock invisible en test. MySQL le refuse.
      const userId = await makeUser('-date');
      const [propId] = await knex('property_profiles').insert({
        user_id: userId, name: 'Villa', property_type: 'apartment',
        bedrooms: 1, beds: 1, bathrooms: 1, max_guests: 2,
      });

      await expect(
        knex('availability_blocks').insert({
          property_id: propId, user_id: userId,
          start_date: 'pas-une-date', end_date: 'non-plus',
        })
      ).rejects.toThrow();
    });

    it("refuse une clé d'idempotence dupliquée dans la file d'envoi", async () => {
      // La garantie « un voyageur est répondu au plus une fois » repose
      // entièrement sur cet index unique.
      const userId = await makeUser('-idem');
      const convId = await makeConversation(userId);
      const [gmailId] = await knex('gmail_accounts').insert({ user_id: userId, email: `g-${TAG}@example.test` });

      const row = {
        user_id: userId, gmail_account_id: gmailId, conversation_id: convId,
        idempotency_key: `key-${TAG}`, status: 'pending', mode: 'auto',
      };
      await knex('outbound_replies').insert(row);
      await expect(knex('outbound_replies').insert(row)).rejects.toThrow(/Duplicate entry/i);
    });
  });

  // ── Isolation et cascades ───────────────────────────────────────────────

  describe('cascades de suppression', () => {
    it('supprime les messages avec leur conversation', async () => {
      const userId = await makeUser('-casc');
      const convId = await makeConversation(userId);
      await knex('messages').insert({ conversation_id: convId, role: 'incoming', content: 'bonjour' });

      await knex('conversations').where('id', convId).del();
      expect(await knex('messages').where('conversation_id', convId)).toHaveLength(0);
    });

    it("supprime conversations et comptes Gmail avec l'utilisateur", async () => {
      const userId = await makeUser('-cascuser');
      const convId = await makeConversation(userId);
      await knex('gmail_accounts').insert({ user_id: userId, email: `gc-${TAG}@example.test` });
      await knex('messages').insert({ conversation_id: convId, role: 'incoming', content: 'x' });

      await knex('users').where('id', userId).del();

      expect(await knex('conversations').where('user_id', userId)).toHaveLength(0);
      expect(await knex('gmail_accounts').where('user_id', userId)).toHaveLength(0);
      expect(await knex('messages').where('conversation_id', convId)).toHaveLength(0);
    });

    it('DOCUMENTE la lacune connue : outbound_replies survit à sa conversation', async () => {
      // outbound_replies n'a AUCUNE clé étrangère (migration 017 déclare les
      // colonnes notNullable mais jamais .references()). Rien ne nettoie donc
      // ces lignes quand la conversation disparaît.
      //
      // Ce test ne valide pas ce comportement : il le FIGE pour qu'une future
      // migration qui ajoute les clés étrangères fasse échouer ce test et
      // oblige à le mettre à jour sciemment. Voir le compte rendu d'audit.
      const userId = await makeUser('-orphan');
      const convId = await makeConversation(userId);
      const [gmailId] = await knex('gmail_accounts').insert({ user_id: userId, email: `go-${TAG}@example.test` });

      await knex('outbound_replies').insert({
        user_id: userId, gmail_account_id: gmailId, conversation_id: convId,
        idempotency_key: `orphan-${TAG}`, status: 'pending', mode: 'auto',
      });

      await knex('conversations').where('id', convId).del();

      const orphans = await knex('outbound_replies').where('conversation_id', convId);
      expect(orphans).toHaveLength(1); // ← devient 0 le jour où les FK sont posées
    });
  });
});

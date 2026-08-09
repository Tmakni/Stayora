/**
 * Ad-hoc perf fixture (not part of the Jest suite): builds a SQLite database
 * shaped like the ~100-concurrent-user target so list/sync queries can be
 * measured against a realistic corpus instead of the 240-row dev database.
 *
 *   node server/tests/seed-perf-db.js <out.db> [users] [convsPerUser] [msgsPerConv]
 */
const fs = require('fs');

const out = process.argv[2];
const USERS = parseInt(process.argv[3], 10) || 100;
const CONVS = parseInt(process.argv[4], 10) || 60;
const MSGS = parseInt(process.argv[5], 10) || 12;

if (!out) {
  console.error('usage: node server/tests/seed-perf-db.js <out.db> [users] [convs] [msgs]');
  process.exit(1);
}

if (fs.existsSync(out)) fs.unlinkSync(out);

const knex = require('knex')({
  client: 'better-sqlite3',
  connection: { filename: out },
  useNullAsDefault: true,
  pool: { min: 1, max: 1 },
  migrations: { directory: require('path').join(__dirname, '..', '..', 'migrations', 'db') },
});

const BODY = 'Bonjour, une question sur le logement. ' + 'lorem ipsum dolor sit amet '.repeat(4);

(async () => {
  await knex.migrate.latest();
  await knex.raw('PRAGMA journal_mode = WAL');

  console.log(`Seeding ${USERS} users x ${CONVS} conversations x ${MSGS} messages...`);
  const now = Date.now();

  for (let u = 0; u < USERS; u++) {
    const [userId] = await knex('users').insert({
      email: `perf-user-${u}@example.test`,
      password_hash: 'x',
    });

    const conversations = [];
    for (let c = 0; c < CONVS; c++) {
      conversations.push({
        user_id: userId,
        title: `Conversation ${c}`,
        guest_name: `Guest${u}_${c}`,
        booking_status: 'inquiry',
        external_provider: 'gmail',
        updated_at: new Date(now - c * 3600_000).toISOString(),
        created_at: new Date(now - c * 3600_000).toISOString(),
      });
    }
    await knex.batchInsert('conversations', conversations, 200);

    // Read the ids back rather than guessing them from an insert return value.
    const rows = await knex('conversations').select('id').where({ user_id: userId });

    const messages = [];
    for (const row of rows) {
      for (let m = 0; m < MSGS; m++) {
        messages.push({
          conversation_id: row.id,
          role: m % 2 ? 'outgoing' : 'incoming',
          content: `${BODY} #${m}`,
          created_at: new Date(now - m * 60_000).toISOString(),
        });
      }
    }
    await knex.batchInsert('messages', messages, 500);

    if ((u + 1) % 20 === 0) console.log(`  ...${u + 1}/${USERS} users`);
  }

  const convCount = await knex('conversations').count({ n: '*' }).first();
  const msgCount = await knex('messages').count({ n: '*' }).first();
  const sampleUser = await knex('users').select('id').orderBy('id', 'desc').first();

  console.log(`Done: ${convCount.n} conversations, ${msgCount.n} messages.`);
  console.log(`Sample userId for benchmarking: ${sampleUser.id}`);

  await knex.destroy();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

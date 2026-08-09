/**
 * Ad-hoc benchmark (not part of the Jest suite): compares the old
 * whole-table-aggregate conversation list query with the new paged version
 * against a real database file.
 *
 *   node server/tests/bench-list-query.js <path-to-sqlite-db> [userId]
 */
const path = process.argv[2];
const userId = parseInt(process.argv[3], 10) || 6;

if (!path) {
  console.error('usage: node server/tests/bench-list-query.js <db-file> [userId]');
  process.exit(1);
}

const knex = require('knex')({
  client: 'better-sqlite3',
  connection: { filename: path },
  useNullAsDefault: true,
  pool: { min: 1, max: 1 },
});

const OLD_QUERY = `
  SELECT c.id, c.title, c.guest_name,
         COALESCE(m_agg.msg_count, 0) AS message_count,
         SUBSTR(m_last.content, 1, 120) AS last_message
  FROM conversations c
  LEFT JOIN (
    SELECT conversation_id, COUNT(*) AS msg_count
    FROM messages GROUP BY conversation_id
  ) m_agg ON m_agg.conversation_id = c.id
  LEFT JOIN (
    SELECT conversation_id, content,
           ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY created_at DESC) AS rn
    FROM messages
  ) m_last ON m_last.conversation_id = c.id AND m_last.rn = 1
  WHERE c.user_id = ?
  ORDER BY c.updated_at DESC
  LIMIT 50 OFFSET 0`;

const NEW_PAGE = `
  SELECT c.id, c.title, c.guest_name, c.updated_at
  FROM conversations c
  WHERE c.user_id = ?
  ORDER BY c.updated_at DESC
  LIMIT 50 OFFSET 0`;

const ITERATIONS = 200;

(async () => {
  const total = await knex('messages').count({ n: '*' }).first();
  const convs = await knex('conversations').count({ n: '*' }).first();
  console.log(`Dataset: ${convs.n} conversations, ${total.n} messages\n`);

  console.log('--- OLD query plan ---');
  for (const row of await knex.raw('EXPLAIN QUERY PLAN ' + OLD_QUERY, [userId])) {
    console.log('   ' + row.detail);
  }

  console.log('\n--- NEW page query plan ---');
  for (const row of await knex.raw('EXPLAIN QUERY PLAN ' + NEW_PAGE, [userId])) {
    console.log('   ' + row.detail);
  }

  const ids = (await knex.raw(NEW_PAGE, [userId])).map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  const COUNTS = `SELECT conversation_id, COUNT(*) AS msg_count FROM messages
                  WHERE conversation_id IN (${ph}) GROUP BY conversation_id`;
  const PREVIEWS = `SELECT conversation_id, last_message FROM (
                      SELECT conversation_id, SUBSTR(content, 1, 120) AS last_message,
                             ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY created_at DESC, id DESC) AS rn
                      FROM messages WHERE conversation_id IN (${ph})
                    ) ranked WHERE rn = 1`;

  // Warm up both paths so the comparison is not measuring page-cache misses.
  for (let i = 0; i < 20; i++) {
    await knex.raw(OLD_QUERY, [userId]);
    await knex.raw(NEW_PAGE, [userId]);
    await knex.raw(COUNTS, ids);
    await knex.raw(PREVIEWS, ids);
  }

  let t = Date.now();
  for (let i = 0; i < ITERATIONS; i++) await knex.raw(OLD_QUERY, [userId]);
  const oldMs = Date.now() - t;

  t = Date.now();
  for (let i = 0; i < ITERATIONS; i++) {
    await knex.raw(NEW_PAGE, [userId]);
    await knex.raw(COUNTS, ids);
    await knex.raw(PREVIEWS, ids);
  }
  const newMs = Date.now() - t;

  console.log(`\n${ITERATIONS} iterations of a 50-row page:`);
  console.log(`   OLD (2 whole-table aggregates): ${oldMs} ms  (${(oldMs / ITERATIONS).toFixed(2)} ms/req)`);
  console.log(`   NEW (paged + 2 scoped queries): ${newMs} ms  (${(newMs / ITERATIONS).toFixed(2)} ms/req)`);
  console.log(`   speedup: ${(oldMs / newMs).toFixed(1)}x`);

  await knex.destroy();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

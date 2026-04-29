/**
 * merge-conversations.js
 *
 * One-shot script that repairs fragmented conversations:
 * Airbnb sends each notification as a separate Gmail thread, so the old
 * sync code created one conversation per Gmail thread instead of grouping
 * by Airbnb thread ID.
 *
 * This script:
 *   1. Finds groups of conversations that share the same airbnb_thread_id
 *   2. Keeps the oldest one as the "primary" conversation
 *   3. Moves all messages + gmail_threads records from duplicates to the primary
 *   4. Updates conversation updated_at to the latest message date
 *   5. Deletes the duplicate conversations
 *
 * Run: wsl bash -c 'cd /mnt/c/home/tom/airbnb-ai-agent && node merge-conversations.js'
 */
const path = require('path');
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

async function main() {
  const { initDatabase, getDatabase } = require('./server/config/db');
  await initDatabase();
  const db = getDatabase();

  // ── Find all airbnb_thread_id values with more than one conversation ──
  const dupes = await db.query(`
    SELECT airbnb_thread_id, COUNT(*) AS cnt
    FROM conversations
    WHERE airbnb_thread_id IS NOT NULL AND airbnb_thread_id != ''
    GROUP BY airbnb_thread_id
    HAVING COUNT(*) > 1
  `);

  if (dupes.length === 0) {
    console.log('✔ No fragmented conversations found — nothing to do.');
    return;
  }

  console.log(`Found ${dupes.length} Airbnb thread(s) split across multiple conversations.`);
  let totalMerged = 0;

  for (const { airbnb_thread_id } of dupes) {
    // Get all conversations for this Airbnb thread, oldest first
    const convs = await db.query(
      `SELECT id, title, property_id, guest_name, created_at
       FROM conversations
       WHERE airbnb_thread_id = ?
       ORDER BY created_at ASC`,
      [airbnb_thread_id]
    );

    const primary = convs[0];
    const duplicates = convs.slice(1);

    console.log(`\nAirbnb thread ${airbnb_thread_id}:`);
    console.log(`  Primary conversation: #${primary.id} "${primary.title}"`);
    console.log(`  Merging ${duplicates.length} duplicate(s): ${duplicates.map(c => '#' + c.id).join(', ')}`);

    for (const dup of duplicates) {
      // Move messages
      await db.query(
        'UPDATE messages SET conversation_id = ? WHERE conversation_id = ?',
        [primary.id, dup.id]
      );

      // Move gmail_threads records
      await db.query(
        'UPDATE gmail_threads SET conversation_id = ? WHERE conversation_id = ?',
        [primary.id, dup.id]
      );

      // Update any reservation links
      await db.query(
        'UPDATE reservations SET conversation_id = ? WHERE conversation_id = ?',
        [primary.id, dup.id]
      );

      // Backfill property_id on primary if missing
      if (!primary.property_id && dup.property_id) {
        await db.query(
          'UPDATE conversations SET property_id = ? WHERE id = ?',
          [dup.property_id, primary.id]
        );
        primary.property_id = dup.property_id;
      }

      // Backfill guest_name on primary if missing
      if (!primary.guest_name && dup.guest_name) {
        await db.query(
          'UPDATE conversations SET guest_name = ? WHERE id = ?',
          [dup.guest_name, primary.id]
        );
        primary.guest_name = dup.guest_name;
      }

      // Delete the duplicate
      await db.query('DELETE FROM conversations WHERE id = ?', [dup.id]);
      console.log(`    Merged #${dup.id} → #${primary.id}`);
    }

    // Update primary's updated_at to the most recent message
    await db.query(`
      UPDATE conversations
      SET updated_at = (
        SELECT MAX(created_at) FROM messages WHERE conversation_id = ?
      )
      WHERE id = ?
    `, [primary.id, primary.id]);

    totalMerged += duplicates.length;
  }

  console.log(`\n✔ Done. Merged ${totalMerged} duplicate conversation(s).`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

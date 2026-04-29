/**
 * backfill-qa.js
 *
 * One-shot script that extracts Q&A pairs from ALL existing conversations
 * and stores them in the property_qa table so the AI can learn from history.
 *
 * Run after the migration is applied:
 *   wsl bash -c 'cd /mnt/c/home/tom/airbnb-ai-agent && node backfill-qa.js'
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

async function main() {
  const { initDatabase, getDatabase } = require('./server/config/db');
  await initDatabase();
  const db = getDatabase();
  const { extractConversationQA } = require('./server/services/propertyQAService');

  // Get all conversations that are linked to a property
  const convs = await db.query(
    'SELECT id, title FROM conversations WHERE property_id IS NOT NULL ORDER BY id ASC'
  );

  if (convs.length === 0) {
    console.log('No conversations linked to a property — nothing to backfill.');
    return;
  }

  console.log(`Processing ${convs.length} conversation(s)...`);
  let totalPairs = 0;

  for (const conv of convs) {
    const pairs = await extractConversationQA(conv.id);
    if (pairs > 0) {
      console.log(`  Conv #${conv.id} "${conv.title}": ${pairs} Q&A pair(s) stored`);
      totalPairs += pairs;
    }
  }

  console.log(`\n✔ Done. ${totalPairs} Q&A pair(s) extracted from existing conversations.`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

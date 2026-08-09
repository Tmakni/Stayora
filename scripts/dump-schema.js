require('dotenv').config();
const knex = require('knex')(require('../knexfile').development);
(async () => {
  for (const t of ['messages', 'conversations', 'gmail_accounts', 'outbound_replies']) {
    if (!(await knex.schema.hasTable(t))) { console.log(`${t}: ABSENTE`); continue; }
    const c = await knex(t).columnInfo();
    console.log(`${t}: ${Object.keys(c).join(', ')}`);
  }
  await knex.destroy();
})();

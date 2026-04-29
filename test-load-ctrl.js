// Test loading gmailController
try {
  require('./server/controllers/gmailController');
  console.log('gmailController loaded OK');
} catch (err) {
  console.error('ERROR loading gmailController:', err.message);
  console.error(err.stack);
}

// Test server startup
try {
  require('./server/server');
} catch (err) {
  console.error('Server startup error:', err.message);
  console.error(err.stack);
  process.exit(1);
}

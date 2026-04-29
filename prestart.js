/**
 * Ensures the better-sqlite3 native module is compiled for the current platform.
 * Runs as a prestart hook — only rebuilds if the binary doesn't load.
 */
try {
  require('better-sqlite3');
  // Binary loads fine for this platform — nothing to do
} catch (e) {
  if (e.message && (e.message.includes('invalid ELF header') || e.message.includes('not a valid Win32 application') || e.message.includes('was compiled against a different'))) {
    console.log('[prestart] Rebuilding better-sqlite3 for current platform (Node ' + process.version + ')...');
    require('child_process').execSync('npm rebuild better-sqlite3', { stdio: 'inherit', cwd: __dirname });
    // Verify the rebuild worked
    try {
      delete require.cache[require.resolve('better-sqlite3')];
      require('better-sqlite3');
      console.log('[prestart] Rebuild successful.');
    } catch (e2) {
      console.error('[prestart] Rebuild failed:', e2.message);
      process.exit(1);
    }
  } else {
    console.error('[prestart] better-sqlite3 error:', e.message);
  }
}

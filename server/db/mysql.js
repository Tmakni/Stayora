const mysql = require('mysql2/promise');
const config = require('../config/env');
const logger = require('../utils/logger');

let pool;

function createPool() {
  const poolConfig = {
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.database,
    waitForConnections: true,
    connectionLimit: config.isProd ? 25 : 10,
    queueLimit: 100, // Prevent unbounded queue (memory exhaustion)
    connectTimeout: 10000, // 10s connection timeout
    charset: 'utf8mb4',
    timezone: 'Z',
    // Prepared statements — prevents SQL injection at driver level
    namedPlaceholders: false,
  };

  // Enable SSL in production
  if (config.isProd && process.env.DB_SSL !== 'false') {
    poolConfig.ssl = { rejectUnauthorized: true };
  }

  pool = mysql.createPool(poolConfig);

  // Monitor pool errors
  pool.on('connection', () => logger.debug('MySQL: new connection created'));

  return pool;
}

async function testConnection() {
  if (!pool) createPool();
  const connection = await pool.getConnection();
  try {
    await connection.ping();
  } finally {
    connection.release();
  }
}

async function query(sql, params = []) {
  if (!pool) createPool();
  try {
    const [rows] = await pool.execute(sql, params);
    return rows;
  } catch (err) {
    logger.error('MySQL query error:', err.message);
    throw err;
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  query,
  testConnection,
  close
};

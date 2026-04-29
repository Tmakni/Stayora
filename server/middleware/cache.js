/**
 * In-memory response cache for hot API endpoints.
 * Short TTL, per-user isolation, automatic invalidation.
 * 
 * Usage: router.get('/', authMiddleware, responseCache(5), handler);
 */

const cache = new Map();
const MAX_ENTRIES = 2000;

// Periodic TTL cleanup every 30s
const CLEANUP_INTERVAL = 30 * 1000;
let _cleanupTimer = null;

function startCleanup(defaultTTL = 10) {
  if (_cleanupTimer) return;
  _cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (now - entry.timestamp > (entry.ttl || defaultTTL) * 1000) {
        cache.delete(key);
      }
    }
  }, CLEANUP_INTERVAL);
  if (_cleanupTimer.unref) _cleanupTimer.unref();
}
startCleanup();

/**
 * Cache middleware factory.
 * @param {number} ttlSeconds - Time-to-live in seconds (default 10)
 */
function responseCache(ttlSeconds = 10) {
  return (req, res, next) => {
    // Only cache GET requests
    if (req.method !== 'GET') return next();

    const key = `${req.userId}:${req.originalUrl}`;
    const entry = cache.get(key);

    if (entry && Date.now() - entry.timestamp < ttlSeconds * 1000) {
      res.set('X-Cache', 'HIT');
      return res.status(entry.status).json(entry.data);
    }

    // Intercept res.json to capture the response
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      // Only cache successful responses
      if (res.statusCode >= 200 && res.statusCode < 400) {
        // Evict if cache too large
        if (cache.size >= MAX_ENTRIES) {
          const oldestKey = cache.keys().next().value;
          cache.delete(oldestKey);
        }
        cache.set(key, { data, status: res.statusCode, timestamp: Date.now(), ttl: ttlSeconds });
      }
      res.set('X-Cache', 'MISS');
      return originalJson(data);
    };

    next();
  };
}

/**
 * Invalidate all cache entries for a user (call after mutations).
 */
function invalidateUser(userId) {
  for (const key of cache.keys()) {
    if (key.startsWith(`${userId}:`)) {
      cache.delete(key);
    }
  }
}

/**
 * Invalidate cache entries matching a URL pattern.
 */
function invalidatePattern(userId, urlPattern) {
  for (const key of cache.keys()) {
    if (key.startsWith(`${userId}:`) && key.includes(urlPattern)) {
      cache.delete(key);
    }
  }
}

/**
 * Clear entire cache.
 */
function clearCache() {
  cache.clear();
}

module.exports = {
  responseCache,
  invalidateUser,
  invalidatePattern,
  clearCache,
};

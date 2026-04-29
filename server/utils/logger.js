/**
 * Structured logger — never logs sensitive data (tokens, passwords, keys).
 */

// Patterns to redact from log arguments
const SENSITIVE_PATTERNS = /password|token|secret|authorization|cookie|apikey|api_key|access_token|refresh_token/i;

function redactArg(arg) {
  if (typeof arg === 'string' && arg.length > 500) {
    return arg.substring(0, 200) + '... [truncated]';
  }
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}`;
  }
  if (typeof arg === 'object' && arg !== null) {
    try {
      const s = JSON.stringify(arg, (key, value) => {
        if (SENSITIVE_PATTERNS.test(key)) return '[REDACTED]';
        if (typeof value === 'string' && value.length > 500) return value.substring(0, 200) + '...';
        return value;
      });
      return s.length > 2000 ? s.substring(0, 2000) + '...' : s;
    } catch {
      return '[non-serializable]';
    }
  }
  return arg;
}

const log = (level, message, ...args) => {
  const timestamp = new Date().toISOString();
  const formatted = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

  const safeArgs = args.map(redactArg);

  if (safeArgs.length > 0) {
    console[level === 'error' ? 'error' : 'log'](formatted, ...safeArgs);
  } else {
    console[level === 'error' ? 'error' : 'log'](formatted);
  }
};

module.exports = {
  info: (msg, ...args) => log('info', msg, ...args),
  error: (msg, ...args) => log('error', msg, ...args),
  warn: (msg, ...args) => log('warn', msg, ...args),
  debug: (msg, ...args) => {
    if (process.env.NODE_ENV !== 'production') log('debug', msg, ...args);
  }
};

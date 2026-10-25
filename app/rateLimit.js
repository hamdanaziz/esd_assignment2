// app/rateLimit.js
// Fixed-window rate limiter, in memory (single instance - fine for this
// assignment; with several replicas you would keep the counters in Redis).
//
//   key      : the caller's IP address (req.ip)  -> every caller on the same IP shares one bucket
//   scope    : one bucket per (limiter name, key), so limits on different endpoints are independent
//   window   : fixed windows of `windowMs`; the counter resets when the window ends
//   on limit : 429 + Retry-After (seconds until the current window ends)
//
// Headers on every response from a limited route (draft IETF RateLimit fields):
//   RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset (seconds)

function rateLimit({ name, windowMs, max, onLimited, sendError }) {
  const buckets = new Map(); // key -> { count, resetAt }

  // Drop expired buckets so the map cannot grow without bound.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, windowMs);
  sweep.unref();

  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    const key = `${name}:${req.ip}`;
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;

    const resetSec = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - b.count)));
    res.set('RateLimit-Reset', String(resetSec));

    if (b.count > max) {
      res.set('Retry-After', String(resetSec));
      if (onLimited) onLimited(req);
      return sendError(req, res, 429, 'RATE_LIMITED',
        `rate limit exceeded: ${max} requests per ${windowMs / 1000}s; retry after ${resetSec}s`,
        undefined, { retryAfterSeconds: resetSec });
    }
    return next();
  };
}

module.exports = { rateLimit };

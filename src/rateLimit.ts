import { NextFunction, Request, Response } from "express";

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  keyPrefix: string;
  keyFn?: (req: Request) => string;
}

export function createRateLimiter(opts: RateLimiterOptions) {
  const buckets = new Map<string, Bucket>();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets.entries()) {
      if (b.resetAt <= now) {
        buckets.delete(k);
      }
    }
  }, Math.max(30_000, opts.windowMs));
  cleanup.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const clientKey = opts.keyFn
      ? opts.keyFn(req)
      : req.ip || req.socket.remoteAddress || "unknown";
    const key = `${opts.keyPrefix}:${clientKey}`;

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, opts.max - bucket.count);
    const resetSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));

    res.setHeader("RateLimit-Limit", String(opts.max));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(resetSec));

    if (bucket.count > opts.max) {
      res.setHeader("Retry-After", String(resetSec));
      res.status(429).json({
        error: "rate_limited",
        message: `Too many requests. Try again in ${resetSec}s.`,
      });
      return;
    }

    next();
  };
}
